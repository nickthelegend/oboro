import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runZingo, ZingoWallet, ZingoViewVerifier } from '../src/index.js';
import { ZingoSession } from '../src/session.js';

const original = { chain: process.env.OBORO_CHAIN, cli: process.env.OBORO_ZINGO_CLI, args: process.env.OBORO_TEST_ARGS_FILE, lock: process.env.OBORO_ZINGO_LOCK_PATH };
afterEach(() => {
  for (const [key, value] of [['OBORO_CHAIN', original.chain], ['OBORO_ZINGO_CLI', original.cli], ['OBORO_TEST_ARGS_FILE', original.args], ['OBORO_ZINGO_LOCK_PATH', original.lock]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

describe('guarded chain selection and CLI arguments', () => {
  it('requires the environment gate even when an option requests mainnet', () => {
    delete process.env.OBORO_CHAIN;
    expect(() => new ZingoWallet({ dataDir: '/tmp/unused', chain: 'mainnet' })).toThrow();
    expect(() => new ZingoViewVerifier({ dataDir: '/tmp/unused', chain: 'mainnet' })).toThrow();
  });
  it('passes mainnet to a one-shot spawn and interactive session', async () => {
    process.env.OBORO_CHAIN = 'mainnet';
    const dir = await mkdtemp(join(tmpdir(), 'oboro-chain-'));
    const cli = join(dir, 'fake-zingo.py');
    const argsFile = join(dir, 'args.json');
    await writeFile(cli, `#!/usr/bin/env python3
import json,os,sys
with open(os.environ['OBORO_TEST_ARGS_FILE'],'w') as f: json.dump(sys.argv[1:],f)
if '--online' in sys.argv:
 print('(main) Block:123 >> ',end='',flush=True)
 for line in sys.stdin:
  if line.strip()=='quit': break
  print('{"height":123}')
  print('(main) Block:123 >> ',end='',flush=True)
else: print('{"height":123}')
`, { mode: 0o700 });
    await chmod(cli, 0o700);
    process.env.OBORO_ZINGO_CLI = cli;
    process.env.OBORO_TEST_ARGS_FILE = argsFile;
    process.env.OBORO_ZINGO_LOCK_PATH = join(dir, 'global.lock');
    let session: ZingoSession | undefined;
    try {
      expect(await runZingo(dir, 'height')).toContain('123');
      const once = JSON.parse(await readFile(argsFile, 'utf8')) as string[];
      expect(once[once.indexOf('--chain') + 1]).toBe('mainnet');
      session = ZingoSession.forWallet(dir, 'mainnet');
      expect(await session.exec('height')).toContain('123');
      const interactive = JSON.parse(await readFile(argsFile, 'utf8')) as string[];
      expect(interactive[interactive.indexOf('--chain') + 1]).toBe('mainnet');
    } finally { await session?.close(); await rm(dir, { recursive: true, force: true }); }
  });
});
