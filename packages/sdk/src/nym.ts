import { OboroError } from './errors.js';
export function parseNymUrl(url: string): { address: string; path: string; search: string } {
  if (!url.startsWith('nym://')) throw new OboroError('invalid_nym_url', 'Expected nym:// URL');
  // WHATWG URL lowercases hostnames, which corrupts case-sensitive Nym recipient IDs.
  const match = /^nym:\/\/([^/?#]+)(\/[^?#]*)?(\?[^#]*)?$/.exec(url);
  if (!match || /[:\s%]/.test(match[1])) throw new OboroError('invalid_nym_url', 'Invalid nym:// URL');
  return { address: match[1], path: match[2] || '/', search: match[3] || '' };
}
