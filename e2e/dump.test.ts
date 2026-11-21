// The e2e failure dump (CI evidence): what a failed scenario leaves in its
// artifact directory, with every planted secret and secret-shaped value
// scrubbed (stack.ts plantedSecrets, and dump.ts's patterns).
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vite-plus/test';

import { oomLines, scrub, writeFailureDump } from './dump.ts';

const PLANTED = ['test-newznab-key', 'test-nntp-password', 'e2e-worker-0123456789abcdef01234567', 'e2e-admin-a1b2c3d4e5f6a7b8', 'jf-api-key-0123456789'];

describe('scrub', () => {
  test('replaces every planted value, also inside JSON and URL-encoded', () => {
    const text = [
      'job failed: login omnarr / test-nntp-password refused',
      JSON.stringify({ token: 'e2e-worker-0123456789abcdef01234567', nested: { k: 'jf-api-key-0123456789' } }),
      `GET /api?apikey=x&t=${encodeURIComponent('e2e-admin-a1b2c3d4e5f6a7b8')}`,
    ].join('\n');
    const out = scrub(text, PLANTED);
    for (const value of PLANTED) expect(out).not.toContain(value);
    expect(out).toContain('login omnarr / [secret] refused');
  });

  test('masks secret-shaped values: an indexer key in a link, a magnet, a JSON password, private keys', () => {
    const text = [
      'http://torznab:4122/getnzb/1.torrent?apikey=unplanted-passkey-123&x=1',
      'magnet:?xt=urn:btih:abcdef&tr=http://tracker/announce?passkey=zz',
      '{"username":"u","password":"unplanted-pass"}',
      '[Interface]\nPrivateKey = aGVsbG8gd29ybGQgdGhpcyBpcyBhIGtleQ==\n',
      '-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49\n-----END PRIVATE KEY-----',
      'authorization: MediaBrowser Token="unplanted-jellyfin-token"',
      'x-api-key: unplanted-gluetun-key',
    ].join('\n');
    const out = scrub(text, []);
    for (const leak of [
      'unplanted-passkey-123',
      'urn:btih:abcdef',
      'passkey=zz',
      'unplanted-pass"',
      'aGVsbG8gd29y',
      'MIGHAgEAMBMG',
      'unplanted-jellyfin-token',
      'unplanted-gluetun-key',
    ])
      expect(out, leak).not.toContain(leak);
    expect(out).toContain('apikey=[secret]&x=1');
    expect(out).toContain('"username":"u"');
  });

  test('ignores empty and very short values, which would scrub ordinary text', () => {
    expect(scrub('admin ran ok', ['', 'ok'])).toBe('admin ran ok');
  });
});

test("keeps only the kernel log's out-of-memory lines", () => {
  const dmesg = [
    '[1.0] eth0: link up',
    '[2.0] ffmpeg invoked oom-killer: gfp_mask=0x140cca',
    '[2.1] Out of memory: Killed process 81761 (ffmpeg) total-vm:3976712kB',
    '[3.0] usb 1-1: new device',
  ];
  expect(oomLines(dmesg.join('\n'))).toEqual([dmesg[1], dmesg[2]]);
});

describe('writeFailureDump', () => {
  let dir = '';
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('writes the logs, the OOM lines and the rows, all scrubbed; a reader that fails leaves a note, not a missing dump', async () => {
    dir = mkdtempSync(join(tmpdir(), 'omnarr-dump-'));
    await writeFailureDump({
      dir,
      planted: PLANTED,
      logs: { worker: () => 'worker: nntp login test-nntp-password', backend: () => 'backend ok' },
      dmesg: () => '[2.1] Out of memory: Killed process 1 (ffmpeg)\n[3.0] other',
      rows: (table) => {
        if (table === 'downloads') throw new Error('convex data failed');
        return [{ _id: `${table}1`, payload: { password: 'unplanted-pass', apiKey: 'test-newznab-key' } }];
      },
      tables: ['jobs', 'renditions', 'downloads', 'issues'],
    });
    expect(readdirSync(dir).sort()).toEqual([
      'backend.log',
      'dmesg-oom.txt',
      'downloads.jsonl',
      'issues.jsonl',
      'jobs.jsonl',
      'renditions.jsonl',
      'worker.log',
    ]);
    expect(readFileSync(join(dir, 'worker.log'), 'utf8')).toBe('worker: nntp login [secret]');
    expect(readFileSync(join(dir, 'dmesg-oom.txt'), 'utf8')).toBe('[2.1] Out of memory: Killed process 1 (ffmpeg)\n');
    const jobs = readFileSync(join(dir, 'jobs.jsonl'), 'utf8');
    expect(jobs).toContain('"_id":"jobs1"');
    expect(jobs).not.toContain('unplanted-pass');
    expect(jobs).not.toContain('test-newznab-key');
    expect(readFileSync(join(dir, 'downloads.jsonl'), 'utf8')).toBe('# not read: convex data failed\n');
  });

  test("keeps the run's timed-out waits with their explain state (stack.ts waitFor), scrubbed", async () => {
    dir = mkdtempSync(join(tmpdir(), 'omnarr-dump-'));
    await writeFailureDump({
      dir,
      planted: PLANTED,
      logs: {},
      dmesg: () => '',
      rows: () => [],
      tables: [],
      timeouts: [
        'Timed out waiting for S01E03 published.\nState: {"jobs":[{"cls":"publish","status":"waiting","lastError":"login test-nntp-password"}]}',
        'Timed out waiting for the VPN up.',
      ],
    });
    expect(readFileSync(join(dir, 'timeouts.txt'), 'utf8')).toBe(
      'Timed out waiting for S01E03 published.\nState: {"jobs":[{"cls":"publish","status":"waiting","lastError":"login [secret]"}]}\n\nTimed out waiting for the VPN up.\n',
    );
  });
});
