import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { OboroError, required } from './errors.js';
import { ZingoSession, redactZingo, zingoGlobalLockPath } from './session.js';
import { resolveChain, networkFor, addressPrefix, type Chain } from './chain.js';

const PY = `import fcntl,subprocess,sys,os,signal
os.umask(0o077)
with open(sys.argv[1],'a+') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX)
 with open(sys.argv[2],'a+') as wallet_lock:
  fcntl.flock(wallet_lock,fcntl.LOCK_EX)
  p=subprocess.Popen(sys.argv[3:],stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=False)
  try: out,err=p.communicate()
  except BaseException:
   p.terminate(); p.wait(); raise
  sys.stdout.buffer.write(out); sys.stderr.buffer.write(err); sys.exit(p.returncode)
`;
const activeGroups = new Set<number>();
process.once('exit', () => { for (const pid of activeGroups) { try { process.kill(-pid, 'SIGTERM'); } catch { /* already exited */ } } });
export async function runZingo(dataDir: string, command: string, args: string[] = [], online = false, viewKey?: string, birthday?: number, chain?: Chain): Promise<string> {
  if (!dataDir) throw new OboroError('setup_required', 'Setup required: OBORO_BUYER_WALLET_DIR');
  const cli = required('OBORO_ZINGO_CLI');
  const server = process.env.OBORO_LIGHTWALLETD;
  const cliArgs = [cli, '--chain', resolveChain(chain), '--data-dir', dataDir, ...(online ? ['--online', '--waitsync'] : ['--offline']), ...(server && online ? ['--server', server] : []), ...(viewKey ? ['--viewkey', viewKey] : []), ...(birthday !== undefined ? ['--birthday', String(birthday)] : []), command, ...args];
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', PY, zingoGlobalLockPath(), ZingoSession.lockPath(dataDir), ...cliArgs], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (child.pid) activeGroups.add(child.pid);
    let stdout = ''; let stderr = '';
    child.stdout.on('data', b => { stdout += String(b); });
    child.stderr.on('data', b => { stderr = (stderr + String(b)).slice(-8192); });
    const timeout = setTimeout(() => { if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already exited */ } } }, online ? 300_000 : 60_000);
    child.on('error', e => { clearTimeout(timeout); if (child.pid) activeGroups.delete(child.pid); reject(e); });
    child.on('close', code => { clearTimeout(timeout); if (child.pid) activeGroups.delete(child.pid); code === 0 ? resolve(stdout) : reject(new OboroError('zingo_failed', `zingo ${command} failed (${code}): ${redactZingo(stderr.slice(-1200))}`)); });
  });
}
export function parseTxid(output: string): string {
  const hits = [...output.matchAll(/(?:txid|transaction[_ ]?id|transaction hash|successfully sent)[^a-f0-9]{0,80}([a-f0-9]{64})/gi)];
  const txid = hits.at(-1)?.[1] ?? output.match(/\b[a-f0-9]{64}\b/i)?.[0];
  if (!txid) throw new OboroError('txid_missing', 'zingo quicksend returned no transaction ID');
  return txid.toLowerCase();
}
export function parseConfirmedBalance(output: string): number {
  const get = (pool: string) => Number(output.match(new RegExp(`^\\s*confirmed_${pool}_balance:\\s*([\\d_]+)`, 'm'))?.[1]?.replaceAll('_', '') ?? '0');
  return get('ironwood') + get('orchard');
}
export class ZingoWallet {
  readonly dataDir: string;
  readonly chain: Chain;
  private readonly session?: ZingoSession;
  constructor(options: { dataDir: string; chain?: string }) {
    this.chain = resolveChain(options.chain);
    if (!options.dataDir) throw new OboroError('setup_required', 'Setup required: OBORO_BUYER_WALLET_DIR');
    this.dataDir = options.dataDir;
    if (process.env.OBORO_ZINGO_SESSION === '1') this.session = ZingoSession.forWallet(this.dataDir, this.chain);
  }
  private command(name: string, args: string[] = [], online = false): Promise<string> {
    return this.session ? this.session.exec(name, args) : runZingo(this.dataDir, name, args, online, undefined, undefined, this.chain);
  }
  async pay(to: string, zats: number, memo: string): Promise<{ txid: string }> {
    if (!to.startsWith(addressPrefix(networkFor(this.chain)))) throw new OboroError('network_mismatch', 'Recipient address does not match wallet network');
    if (!Number.isSafeInteger(zats) || zats <= 0 || !memo.startsWith('oboro:')) throw new OboroError('invalid_payment', 'Invalid pay arguments');
    if (this.session) await this.session.ensureSynced(20_000);
    return { txid: parseTxid(await this.command('quicksend', [to, String(zats), memo], true)) };
  }
  async balance(): Promise<number> { if (this.session) await this.session.ensureSynced(20_000); return parseConfirmedBalance(await this.command('balance')); }
  async height(): Promise<number> { if (this.session) await this.session.ensureSynced(20_000); const v = JSON.parse(await this.command('height')) as { height: number }; return v.height; }
  async unifiedAddress(): Promise<string> { const v = JSON.parse(await this.command('addresses')) as { encoded_address: string }[]; if (!v[0]?.encoded_address) throw new OboroError('address_missing', 'No unified address in wallet'); return v[0].encoded_address; }
  async exportViewingKeyToFile(path: string): Promise<void> {
    const raw = (await this.command('export_ufvk')).trim();
    const key = raw.match(/(?:uview|ufvk)[a-z0-9]+/i)?.[0];
    if (!key) throw new OboroError('viewkey_missing', 'zingo did not return a viewing key');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, key, { mode: 0o600 });
  }
}
