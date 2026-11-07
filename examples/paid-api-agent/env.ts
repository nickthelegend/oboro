import dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
let candidate = process.cwd();
while (!existsSync(resolve(candidate, 'pnpm-workspace.yaml')) && dirname(candidate) !== candidate) {
  candidate = dirname(candidate);
}
export const repoRoot = candidate;
export const repoPath = (path: string) => isAbsolute(path) ? path : resolve(repoRoot, path);
for (const relative of ['.env', '../../.env', '../../../.env']) {
  const path = resolve(process.cwd(), relative);
  if (existsSync(path)) { dotenv.config({ path }); break; }
}
