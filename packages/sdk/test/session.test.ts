import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InteractiveFramer, redactZingo, ZingoSession } from '../src/session.js';
import { ZingoViewVerifier } from '../src/verifier.js';

// Redacted transcript captured from the real online seller view wallet.
const realHeight = '{\n  "height": 4581235\n}\n(test) Block:4581235 [Syncing 648 / 648 outputs] >> ';
const realStatus = '{\n  "scan_ranges": [{"priority":"Scanned","start_block":"4581000","end_block":"4581235"}],\n  "percentage_total_outputs_scanned": 100\n}\n(test) Block:4581235 [Syncing 648 / 648 outputs] >> ';

describe('interactive zingo output', () => {
  it('frames real JSON output at the prompt across arbitrary chunks', () => {
    const framer = new InteractiveFramer();
    expect(framer.feed(realHeight.slice(0, 25))).toEqual([]);
    expect(framer.feed(realHeight.slice(25))).toEqual([{ output: '{\n  "height": 4581235\n}', prompt: '(test) Block:4581235 [Syncing 648 / 648 outputs] >> ' }]);
    expect(JSON.parse(framer.feed(realStatus)[0].output)).toMatchObject({ percentage_total_outputs_scanned: 100 });
  });
  it('frames two commands in one chunk and retains an incomplete prompt', () => {
    const framer = new InteractiveFramer();
    expect(framer.feed(realHeight + realStatus.slice(0, -2))).toHaveLength(1);
    expect(framer.feed(realStatus.slice(-2))).toHaveLength(1);
  });
  it('redacts viewing keys, addresses, and seed-shaped text', () => {
    const text = `uviewtest${'a'.repeat(80)} utest1${'b'.repeat(80)} ${Array(24).fill('word').join(' ')}`;
    expect(redactZingo(text)).toBe('[REDACTED_KEY] [REDACTED_ADDRESS] [REDACTED_SEED]');
  });
});

const fakeCli = `#!/usr/bin/env python3
import sys,time
def prompt():
 print('(test) Block:4581235 [Syncing 648 / 648 outputs] >> ',end='',flush=True)
prompt()
for line in sys.stdin:
 command=line.strip()
 if command=='quit': break
 if command=='slow': time.sleep(.15); print('slow-done')
 elif command=='hang': time.sleep(4); print('hang-done')
 elif command=='height': print('{"height":4581235}')
 elif command=='sync run': print('Sync task already running.')
 elif command=='sync status': print('{"scan_ranges":[{"priority":"Scanned","end_block":"4581235"}],"percentage_total_outputs_scanned":100}')
 elif command=='messages': print('{"value_transfers":[{"txid":"'+'b'*64+'","kind":"received","value":2000,"memos":["oboro:'+'a'*32+'"],"blockheight":4581235,"status":"confirmed","pools_received":["Ironwood"]}]}')
 elif command=='secret': print('Error: uviewtest'+'a'*80)
 elif command=='crash': sys.exit(1)
 else: print('Error: unsupported command')
 prompt()
`;

const sessions: ZingoSession[] = [];
const originalCli = process.env.OBORO_ZINGO_CLI;
const originalSession = process.env.OBORO_ZINGO_SESSION;
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.close()));
  if (originalCli === undefined) delete process.env.OBORO_ZINGO_CLI;
  else process.env.OBORO_ZINGO_CLI = originalCli;
  if (originalSession === undefined) delete process.env.OBORO_ZINGO_SESSION;
  else process.env.OBORO_ZINGO_SESSION = originalSession;
});
async function fakeSession(): Promise<ZingoSession> {
  const dir = await mkdtemp(join(tmpdir(), 'oboro-session-test-'));
  const cli = join(dir, 'fake-zingo.py');
  await writeFile(cli, fakeCli, { mode: 0o700 });
  await chmod(cli, 0o700);
  process.env.OBORO_ZINGO_CLI = cli;
  const session = ZingoSession.forWallet(dir);
  sessions.push(session);
  return session;
}

describe('ZingoSession command flow', () => {
  it('serializes queued commands and completes a sync from scan status', async () => {
    const session = await fakeSession();
    const first = session.exec('slow');
    const second = session.exec('height');
    expect(await first).toBe('slow-done');
    expect(JSON.parse(await second)).toEqual({ height: 4581235 });
    expect(await session.ensureSynced(20_000)).toBe(4581235);
  });
  it('times out a stalled command with a readable error', async () => {
    const session = await fakeSession();
    await expect(session.exec('hang', [], 40)).rejects.toThrow('timed out');
  });
  it('fails loudly on an interactive command error', async () => {
    const session = await fakeSession();
    await expect(session.exec('unknown')).rejects.toThrow('unsupported command');
  });
  it('redacts keys from command errors', async () => {
    const session = await fakeSession();
    await expect(session.exec('secret')).rejects.toThrow('Error: [REDACTED_KEY]');
  });
  it('restarts once after an unexpected CLI exit', async () => {
    const session = await fakeSession();
    const restarted = new Promise(resolve => session.once('restart', resolve));
    await expect(session.exec('crash')).rejects.toThrow('exited');
    await restarted;
    expect(JSON.parse(await session.exec('height'))).toEqual({ height: 4581235 });
  });
  it('uses the synced height for the configured confirmation threshold', async () => {
    const session = await fakeSession();
    process.env.OBORO_ZINGO_SESSION = '1';
    const txid = 'b'.repeat(64);
    const nonce = 'a'.repeat(32);
    const one = new ZingoViewVerifier({ dataDir: session.dataDir, minConfirmations: 1 });
    const two = new ZingoViewVerifier({ dataDir: session.dataDir, minConfirmations: 2 });
    expect((await one.find(txid, nonce, 2000)).found).toBe(true);
    const pending = await two.find(txid, nonce, 2000);
    expect(pending).toMatchObject({ found: false, confirmations: 1 });
  });
});
