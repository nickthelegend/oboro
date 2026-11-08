import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';

const prefix = Buffer.from('302a300506032b656e032100', 'hex');
const b64 = (b: Buffer) => b.toString('base64url');
const rawPublic = (key: ReturnType<typeof createPublicKey>) => key.export({ type: 'spki', format: 'der' }).subarray(-32);
const publicKey = (raw: Buffer) => createPublicKey({ key: Buffer.concat([prefix, raw]), type: 'spki', format: 'der' });
const decode = (value: string, size: number) => { if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid sealed key'); const b = Buffer.from(value, 'base64url'); if (b.length !== size || b64(b) !== value) throw new Error('Invalid sealed key'); return b; };
export type Sealed = { alg: 'x25519-hkdf-sha256-aes256gcm'; epk: string; iv: string; ct: string; tag: string };
export function oneTimeKey() { const { publicKey: pk, privateKey: sk } = generateKeyPairSync('x25519'); return { publicKey: b64(rawPublic(pk)), privateKey: sk }; }
export function seal(value: unknown, recipient: string): Sealed {
  const rp = decode(recipient, 32); const { publicKey: epk, privateKey } = generateKeyPairSync('x25519'); const raw = rawPublic(epk);
  const key = Buffer.from(hkdfSync('sha256', diffieHellman({ privateKey, publicKey: publicKey(rp) }), Buffer.concat([raw, rp]), 'oboro-card-v1', 32));
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); const ct = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return { alg: 'x25519-hkdf-sha256-aes256gcm', epk: b64(raw), iv: b64(iv), ct: b64(ct), tag: b64(cipher.getAuthTag()) };
}
export function openSeal<T = unknown>(sealed: Sealed, privateKey: ReturnType<typeof createPrivateKey>): T {
  if (sealed.alg !== 'x25519-hkdf-sha256-aes256gcm') throw new Error('Invalid sealed algorithm');
  const epk = decode(sealed.epk, 32); const rp = rawPublic(createPublicKey(privateKey));
  const key = Buffer.from(hkdfSync('sha256', diffieHellman({ privateKey, publicKey: publicKey(epk) }), Buffer.concat([epk, rp]), 'oboro-card-v1', 32));
  const decipher = createDecipheriv('aes-256-gcm', key, decode(sealed.iv, 12)); decipher.setAuthTag(decode(sealed.tag, 16));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.ct, 'base64url')), decipher.final()]).toString('utf8')) as T;
}
export function validSealTo(value: unknown): value is string { try { if (typeof value !== 'string') return false; decode(value, 32); return true; } catch { return false; } }
