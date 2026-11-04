import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { OboroError, required } from './errors.js';

export function redactZingo(value: string): string {
  return value
    .replace(/(?:\b[a-z]+\s+){11,23}[a-z]+\b/gi, '[REDACTED_SEED]')
    .replace(/(?:secret-extended-key-(?:main|test)1|usk(?:test)?1)[a-z0-9]+/gi, '[REDACTED_KEY]')
    .replace(/(?:ufvk|uview(?:test)?)[a-z0-9]{20,}/gi, '[REDACTED_KEY]')
    .replace(/(?:u1|utest1|zs1|ztestsapling1)[a-z0-9]{30,}/gi, '[REDACTED_ADDRESS]');
}

export interface InteractiveFrame { output: string; prompt: string }

// Captured from the real seller view wallet on 2026-11-04: startup printed
// "Launching sync task...", then "(test) Block:0 [Syncing] >> ". `height`
// printed a JSON object followed by the same prompt with the current block.
// `sync status` printed JSON scan ranges and percentages; `sync run` replied
// "Sync task already running." while the startup sync task was active. The
// prompt, rather than a newline or JSON brace, ends each interactive command.
const PROMPT = /(?:^|\r?\n)(\(test\) Block:\d+(?: \[[^\]\r\n]*\])? >> )/;
export class InteractiveFramer {
  private pending = '';
  feed(chunk: string): InteractiveFrame[] {
    this.pending += chunk;
    if (this.pending.length > 2_000_000) throw new OboroError('zingo_output', 'zingo interactive output exceeded 2 MB');
    const frames: InteractiveFrame[] = [];
    for (;;) {
      const match = PROMPT.exec(this.pending);
      if (!match) break;
      frames.push({ output: this.pending.slice(0, match.index).trim(), prompt: match[1] });
      this.pending = this.pending.slice(match.index + match[0].length);
    }
    return frames;
  }
  remainder(): string { return this.pending; }
  clear(): void { this.pending = ''; }
}

// The wrapper keeps a per-wallet advisory lock for the full interactive lifetime.
// It also takes the existing global lock during CLI startup, then releases it
// when the first prompt arrives so other wallets can run while this one stays up.
const PY_SESSION = `import fcntl,os,re,subprocess,sys,threading,signal
os.umask(0o077)
global_lock=open('/tmp/oboro-zingo.lock','a+')
fcntl.flock(global_lock,fcntl.LOCK_EX)
wallet_lock=open(sys.argv[1],'a+')
fcntl.flock(wallet_lock,fcntl.LOCK_EX)
p=subprocess.Popen(sys.argv[2:],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,bufsize=0)
def input_loop():
 try:
  while True:
   data=os.read(0,4096)
   if not data: break
   p.stdin.write(data); p.stdin.flush()
 except (BrokenPipeError,OSError): pass
threading.Thread(target=input_loop,daemon=True).start()
startup=True
tail=b''
try:
 while True:
  data=os.read(p.stdout.fileno(),8192)
  if not data: break
  os.write(1,data)
  if startup:
   tail=(tail+data)[-512:]
   if re.search(rb'\\(test\\) Block:\\d+(?: \\[[^\\]\\r\\n]*\\])? >> ',tail):
    fcntl.flock(global_lock,fcntl.LOCK_UN)
    startup=False
finally:
 if p.poll() is None:
  p.terminate()
  try: p.wait(timeout=5)
  except subprocess.TimeoutExpired: p.kill(); p.wait()
sys.exit(p.returncode)
`;

const activeGroups = new Set<number>();
process.once('exit', () => { for (const pid of activeGroups) { try { process.kill(-pid, 'SIGTERM'); } catch { /* exited */ } } });

export class ZingoSession extends EventEmitter {
  private static sessions = new Map<string, ZingoSession>();
  static lockPath(dataDir: string): string { return `/tmp/oboro-zingo-${createHash('sha256').update(resolve(dataDir)).digest('hex').slice(0, 24)}.lock`; }
  static forWallet(dataDir: string): ZingoSession {
    const key = resolve(dataDir);
    let session = this.sessions.get(key);
    if (!session) { session = new ZingoSession(key); this.sessions.set(key, session); }
    return session;
  }

  private child?: ChildProcessWithoutNullStreams;
  private framer = new InteractiveFramer();
  private ready?: Promise<void>;
  private startup?: { resolve: () => void; reject: (error: Error) => void };
  private pending?: { resolve: (value: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
  private tail: Promise<unknown> = Promise.resolve();
  private syncTask?: Promise<number>;
  private loop?: NodeJS.Timeout;
  private restartCount = 0;
  private dying = false;
  private closing = false;
  private lastSync = 0;
  private syncedHeight = 0;

  constructor(readonly dataDir: string) { super(); }

  private start(): Promise<void> {
    if (this.closing) return Promise.reject(new OboroError('zingo_closed', 'zingo session is closed'));
    if (this.ready) return this.ready;
    this.dying = false;
    this.ready = new Promise<void>((resolveReady, rejectReady) => {
      const cli = required('OBORO_ZINGO_CLI');
      const server = process.env.OBORO_LIGHTWALLETD;
      const args = [ZingoSession.lockPath(this.dataDir), cli, '--chain', 'testnet', '--data-dir', this.dataDir, '--online', ...(server ? ['--server', server] : [])];
      const child = spawn('python3', ['-u', '-c', PY_SESSION, ...args], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;
      if (child.pid) activeGroups.add(child.pid);
      const timer = setTimeout(() => this.fail(new OboroError('zingo_timeout', 'zingo interactive startup timed out')), 180_000);
      this.startup = {
        resolve: () => { clearTimeout(timer); resolveReady(); this.startLoop(); },
        reject: error => { clearTimeout(timer); rejectReady(error); },
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => this.onOutput(chunk));
      child.stdin.on('error', () => { /* close and crash paths handle broken pipes */ });
      // Never surface raw stderr: it can include CLI arguments or wallet data.
      child.stderr.on('data', () => {});
      child.on('error', error => this.fail(new OboroError('zingo_failed', `zingo process error: ${redactZingo(error.message)}`)));
      child.on('close', code => {
        if (child.pid) activeGroups.delete(child.pid);
        if (this.child !== child) return;
        this.child = undefined;
        this.ready = undefined;
        this.framer.clear();
        this.lastSync = 0;
        if (this.loop) { clearInterval(this.loop); this.loop = undefined; }
        const error = new OboroError('zingo_failed', `zingo interactive process exited (${code ?? 'signal'})`);
        this.rejectPending(error);
        this.startup?.reject(error);
        this.startup = undefined;
        if (!this.closing && this.restartCount++ === 0) {
          this.emit('restart', { reason: error.message });
          void this.start().catch(() => {});
        } else if (!this.closing) this.emit('crash', { reason: error.message });
      });
    });
    return this.ready;
  }

  private onOutput(chunk: string): void {
    try {
      for (const frame of this.framer.feed(chunk)) {
        if (this.startup) { const startup = this.startup; this.startup = undefined; startup.resolve(); continue; }
        const pending = this.pending;
        if (!pending) continue;
        this.pending = undefined;
        clearTimeout(pending.timer);
        if (/^(?:Error|Failed|No Signing Key)\b/im.test(frame.output)) pending.reject(new OboroError('zingo_failed', redactZingo(frame.output.slice(-1200))));
        else pending.resolve(frame.output);
      }
    } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
  }

  private rejectPending(error: Error): void {
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = undefined; }
  }
  private fail(error: Error): void {
    this.dying = true;
    this.rejectPending(error);
    this.startup?.reject(error);
    this.startup = undefined;
    if (this.child?.pid) { try { process.kill(-this.child.pid, 'SIGTERM'); } catch { /* exited */ } }
  }
  private startLoop(): void {
    if (this.loop) return;
    this.loop = setInterval(() => { void this.ensureSynced(20_000).catch(error => this.emit('syncError', { reason: redactZingo(String(error)) })); }, 20_000);
    this.loop.unref();
  }

  exec(command: string, args: string[] = [], timeoutMs = 120_000): Promise<string> {
    if (!/^[a-z][a-z_]*$/i.test(command) || args.some(arg => /[\r\n\s]/.test(arg))) return Promise.reject(new OboroError('zingo_command', 'Invalid interactive command or argument'));
    const run = async (): Promise<string> => {
      await this.start();
      if (this.dying) throw new OboroError('zingo_failed', 'zingo interactive process is restarting');
      return new Promise<string>((resolveCommand, rejectCommand) => {
        const child = this.child;
        if (!child?.stdin.writable) { rejectCommand(new OboroError('zingo_failed', 'zingo interactive stdin is closed')); return; }
        const timer = setTimeout(() => this.fail(new OboroError('zingo_timeout', `zingo ${command} timed out after ${timeoutMs} ms`)), timeoutMs);
        this.pending = { resolve: resolveCommand, reject: rejectCommand, timer };
        child.stdin.write(`${command}${args.length ? ` ${args.join(' ')}` : ''}\n`, error => {
          if (error) this.fail(new OboroError('zingo_failed', `zingo stdin error: ${redactZingo(error.message)}`));
        });
      });
    };
    const result = this.tail.then(run, run);
    this.tail = result.catch(() => {});
    return result;
  }

  async ensureSynced(maxAgeMs: number): Promise<number> {
    if (Date.now() - this.lastSync <= maxAgeMs) return this.syncedHeight;
    if (this.syncTask) return this.syncTask;
    this.syncTask = (async () => {
      await this.exec('sync', ['run'], 30_000);
      const deadline = Date.now() + 300_000;
      while (Date.now() < deadline) {
        const status = JSON.parse(await this.exec('sync', ['status'], 30_000)) as { scan_ranges?: { priority: string; end_block: string }[]; percentage_total_outputs_scanned?: number };
        const height = (JSON.parse(await this.exec('height', [], 30_000)) as { height: number }).height;
        const scanned = Math.max(0, ...(status.scan_ranges ?? []).filter(range => range.priority === 'Scanned').map(range => Number(range.end_block)));
        if (height > 0 && scanned >= height && status.percentage_total_outputs_scanned === 100) {
          this.syncedHeight = height;
          this.lastSync = Date.now();
          return height;
        }
        await new Promise(resolve => setTimeout(resolve, 2_000));
      }
      throw new OboroError('zingo_timeout', 'zingo sync did not complete within 5 minutes');
    })().finally(() => { this.syncTask = undefined; });
    return this.syncTask;
  }

  async close(): Promise<void> {
    this.closing = true;
    ZingoSession.sessions.delete(resolve(this.dataDir));
    if (this.loop) clearInterval(this.loop);
    const child = this.child;
    if (!child) return;
    const closed = new Promise<void>(resolveClosed => child.once('close', () => resolveClosed()));
    if (child.stdin.writable && !child.stdin.destroyed) child.stdin.write('quit\n', () => {});
    const timer = setTimeout(() => { if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* exited */ } } }, 2_000);
    const force = setTimeout(() => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exited */ } } }, 5_000);
    await closed;
    clearTimeout(timer);
    clearTimeout(force);
  }
}
