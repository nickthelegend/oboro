import '../src/env.js';
import { chmod, readFile, stat } from 'node:fs/promises';
import { required, runZingo, ZingoWallet } from 'oboro';
import { repoPath } from '../src/env.js';

const seller = new ZingoWallet({ dataDir: required('OBORO_SELLER_WALLET_DIR') });
const viewDir = repoPath(process.env.OBORO_SELLER_VIEW_DIR ?? '.oboro/seller-view');
const keyFile = repoPath('.oboro/seller.ufvk');
await seller.exportViewingKeyToFile(keyFile);
const mode = (await stat(keyFile)).mode & 0o777;
if (mode !== 0o600) throw new Error('View key file must have mode 600');
const key = (await readFile(keyFile, 'utf8')).trim();
// A view wallet only has to see payments made from now on. OBORO_SELLER_VIEW_BIRTHDAY (a recent height) skips
// scanning the seller wallet's whole history, which takes many minutes on a first sync.
const birthday = Number(process.env.OBORO_SELLER_VIEW_BIRTHDAY ?? (await runZingo(seller.dataDir, 'birthday')).trim());
if (!Number.isSafeInteger(birthday) || birthday < 0) throw new Error('Invalid seller wallet birthday');
const existing = await stat(`${viewDir}/zingo-wallet.dat`).then(() => true, () => false);
await runZingo(viewDir, 'height', [], false, existing ? undefined : key, existing ? undefined : birthday);
await chmod(`${viewDir}/zingo-wallet.dat`, 0o600);
console.log(JSON.stringify({ setup: 'seller-view', viewDir, keyFile, mode: '600' }));
