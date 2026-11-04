import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { OboroError, required } from './errors.js';

const PY = `import fcntl,subprocess,sys,os,signal
os.umask(0o077)
with open('/tmp/oboro-zingo.lock','a+') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX)
 p=subprocess.Popen(sys.argv[1:],stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=False)
 try: out,err=p.communicate()
 except BaseException:
  p.terminate(); p.wait(); raise
 sys.stdout.buffer.write(out); sys.stderr.buffer.write(err); sys.exit(p.returncode)
`;
const activeGroups = new Set<number>();
process.once('exit', () => { for (const pid of activeGroups) { try { process.kill(-pid, 'SIGTERM'); } catch { /* already exited */ } } });
function redact(s: string): string {
  return s.replace(/(?:\b[a-z]+\s+){23}[a-z]+\b/gi, '[REDACTED_SEED]').replace(/(?:ufvk|uview)[a-z0-9]{20,}/gi, '[REDACTED_KEY]').replace(/(?:u1|utest1|zs1|ztestsapling1)[a-z0-9]{30,}/gi, '[REDACTED_ADDRESS]');
}
export async function runZingo(dataDir: string, command: string, args: string[] = [], online = false, viewKey?: string, birthday?: number): Promise<string> {
  if (!dataDir) throw new OboroError('setup_required', 'Setup required: OBORO_BUYER_WALLET_DIR');
  const cli = required('OBORO_ZINGO_CLI');
  const cliArgs = [cli, '--chain', 'testnet', '--data-dir', dataDir, ...(online ? ['--online', '--waitsync'] : ['--offline']), ...(viewKey ? ['--viewkey', viewKey] : []), ...(birthday !== undefined ? ['--birthday', String(birthday)] : []), command, ...args];
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', PY, ...cliArgs], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (child.pid) activeGroups.add(child.pid);
    let stdout = ''; let stderr = '';
    child.stdout.on('data', b => { stdout += String(b); });
    child.stderr.on('data', b => { stderr = (stderr + String(b)).slice(-8192); });
    const timeout = setTimeout(() => { if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already exited */ } } }, online ? 300_000 : 60_000);
    child.on('error', e => { clearTimeout(timeout); if (child.pid) activeGroups.delete(child.pid); reject(e); });
    child.on('close', code => { clearTimeout(timeout); if (child.pid) activeGroups.delete(child.pid); code === 0 ? resolve(stdout) : reject(new OboroError('zingo_failed', `zingo ${command} failed (${code}): ${redact(stderr.slice(-1200))}`)); });
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
  constructor(options: { dataDir: string; chain?: string }) {
    if (options.chain && options.chain !== 'testnet') throw new OboroError('network_refused', 'Only testnet is supported');
    if (!options.dataDir) throw new OboroError('setup_required', 'Setup required: OBORO_BUYER_WALLET_DIR');
    this.dataDir = options.dataDir;
  }
  async pay(to: string, zats: number, memo: string): Promise<{ txid: string }> {
    if (!to.startsWith('utest1')) throw new OboroError('network_refused', 'Only Zcash testnet unified addresses are supported');
    if (!Number.isSafeInteger(zats) || zats <= 0 || !memo.startsWith('oboro:')) throw new OboroError('invalid_payment', 'Invalid pay arguments');
    return { txid: parseTxid(await runZingo(this.dataDir, 'quicksend', [to, String(zats), memo], true)) };
  }
  async balance(): Promise<number> { return parseConfirmedBalance(await runZingo(this.dataDir, 'balance')); }
  async height(): Promise<number> { const v = JSON.parse(await runZingo(this.dataDir, 'height')) as { height: number }; return v.height; }
  async unifiedAddress(): Promise<string> { const v = JSON.parse(await runZingo(this.dataDir, 'addresses')) as { encoded_address: string }[]; if (!v[0]?.encoded_address) throw new OboroError('address_missing', 'No unified address in wallet'); return v[0].encoded_address; }
  async exportViewingKeyToFile(path: string): Promise<void> {
    const raw = (await runZingo(this.dataDir, 'export_ufvk')).trim();
    const key = raw.match(/(?:uview|ufvk)[a-z0-9]+/i)?.[0];
    if (!key) throw new OboroError('viewkey_missing', 'zingo did not return a viewing key');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, key, { mode: 0o600 });
  }
}
