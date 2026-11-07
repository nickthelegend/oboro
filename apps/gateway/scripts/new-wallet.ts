import '../src/env.js';
import { chmod, mkdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { required, runZingo, ZingoWallet } from 'oboro';

const input = process.argv[2];
if (!input || process.argv.length !== 3) throw new Error('Usage: pnpm --filter @oboro/gateway wallet:new <dir>');
if (process.env.OBORO_CHAIN !== undefined && process.env.OBORO_CHAIN !== 'testnet' && process.env.OBORO_CHAIN !== 'mainnet') throw new Error('OBORO_CHAIN must be testnet or mainnet');
const chain = process.env.OBORO_CHAIN === 'mainnet' ? 'mainnet' : 'testnet';
const dir = resolve(input);
const existing = await stat(dir).then(() => true, () => false);
if (existing) throw new Error('Wallet directory already exists; choose a new directory');
required('OBORO_ZINGO_CLI');
await mkdir(dir, { mode: 0o700 });
await chmod(dir, 0o700);
// A new zingo wallet is created on first use. Never forward its startup output.
try {
  await runZingo(dir, 'info', [], true, undefined, undefined, chain);
  if (!(await stat(join(dir, 'zingo-wallet.dat'))).isFile()) throw new Error('Wallet file was not created');
  const wallet = new ZingoWallet({ dataDir: dir, chain });
  const address = await wallet.unifiedAddress();
  if (!address.startsWith(chain === 'mainnet' ? 'u1' : 'utest1')) throw new Error('New wallet address has the wrong network');
  const birthday = Number((await runZingo(dir, 'birthday', [], false, undefined, undefined, chain)).trim());
  if (!Number.isSafeInteger(birthday) || birthday < 0) throw new Error('Invalid wallet birthday');
  console.log(JSON.stringify({ address, birthday }));
} catch {
  // CLI startup can contain wallet secrets; never surface its output on an error.
  throw new Error('Wallet creation failed; check the zingo CLI and lightwalletd configuration');
}
