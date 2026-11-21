// The host-wide pieces of the e2e runs (host.ts): the per-checkout project
// name, the slots, the media cache key; and stack.ts's `convex data` parsing.
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vite-plus/test';

import { cachedMediaPath, projectFor, releaseSlot, slotCount, slotHolders, tryTakeSlot, type SlotProbe } from './host.ts';
import { jsonLines } from './stack.ts';

const dirs: string[] = [];
const cache = () => {
  const dir = mkdtempSync(join(tmpdir(), 'omnarr-e2e-host-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Every holder alive, unless named dead; no stack running unless named. */
const probe = (dead: number[] = [], running: string[] = [], now = Date.now()): SlotProbe => ({
  alive: (pid) => !dead.includes(pid),
  running: (project) => running.includes(project),
  now: () => now,
});
const own = (dir: string, n: number, project: string, pid: number) => {
  mkdirSync(join(dir, 'slots', String(n)), { recursive: true });
  writeFileSync(join(dir, 'slots', String(n), 'owner.json'), JSON.stringify({ project, pid, at: 0 }));
};

describe('jsonLines (rows())', () => {
  test("skips the CLI's reconnect lines before the documents", () => {
    const out = [
      'Attempting to connect to deployment at http://127.0.0.1:3210... (attempt 1)',
      'Attempting to connect to deployment at http://127.0.0.1:3210... (attempt 2)',
      '{"_id":"a","state":"ready"}',
      '',
      '{"_id":"b","state":"wanted"}',
    ].join('\n');
    expect(jsonLines(out)).toEqual([
      { _id: 'a', state: 'ready' },
      { _id: 'b', state: 'wanted' },
    ]);
  });

  test('answers no documents for an empty table', () => {
    expect(jsonLines('There are no documents in this table.\n')).toEqual([]);
  });
});

describe('projectFor', () => {
  test('names the project after the checkout folder, as compose takes it', () => {
    expect(projectFor('tech-omn-46-e2e-fail-fa-fee90fc53f5d2612')).toBe('omnarr-e2e-tech-omn-46-e2e-fail-fa-fee90fc53f5d2612');
    expect(projectFor('Omnarr.Main')).toBe('omnarr-e2e-omnarr-main');
    expect(projectFor('omnarr')).toBe('omnarr-e2e-omnarr');
  });

  test('two worktrees get two projects', () => {
    expect(projectFor('tech-omn-46-a')).not.toBe(projectFor('tech-omn-47-b'));
  });

  test('falls back to omnarr-e2e for a folder with nothing compose takes', () => {
    expect(projectFor('...')).toBe('omnarr-e2e');
  });

  test('stays a valid compose project name', () => {
    for (const folder of ['x'.repeat(200), '__a b__', 'ÄÖÜ-worktree']) expect(projectFor(folder)).toMatch(/^[a-z0-9][a-z0-9_-]{0,62}$/);
  });
});

describe('slots', () => {
  test('two runs take the two slots, and a third finds none', () => {
    const dir = cache();
    expect(tryTakeSlot('a', 2, dir, probe())).toBe(1);
    expect(tryTakeSlot('b', 2, dir, probe())).toBe(2);
    expect(tryTakeSlot('c', 2, dir, probe())).toBeUndefined();
    expect(slotHolders(dir).sort()).toEqual(['a', 'b']);
  });

  test('a released slot is taken by the next run', () => {
    const dir = cache();
    tryTakeSlot('a', 1, dir, probe());
    releaseSlot('a', dir);
    expect(tryTakeSlot('b', 1, dir, probe())).toBe(1);
  });

  test('a project that holds a slot gets it again (a kept stack run once more)', () => {
    const dir = cache();
    tryTakeSlot('a', 2, dir, probe());
    expect(tryTakeSlot('a', 2, dir, probe())).toBe(1);
    expect(slotHolders(dir)).toEqual(['a']);
  });

  test('a slot whose run died and whose stack is gone is free again', () => {
    const dir = cache();
    own(dir, 1, 'a', 4242);
    expect(tryTakeSlot('b', 1, dir, probe([4242]))).toBe(1);
  });

  test("a kept stack's slot stays held after its run ended, while its containers run", () => {
    const dir = cache();
    own(dir, 1, 'a', 4242);
    expect(tryTakeSlot('b', 1, dir, probe([4242], ['a']))).toBeUndefined();
  });

  test('a slot left half made (no owner) is free after a minute', () => {
    const dir = cache();
    mkdirSync(join(dir, 'slots', '1'), { recursive: true });
    expect(tryTakeSlot('b', 1, dir, probe())).toBeUndefined();
    expect(tryTakeSlot('b', 1, dir, probe([], [], Date.now() + 120_000))).toBe(1);
  });

  test('a lock left by a dead taker clears after 30 s', () => {
    const dir = cache();
    mkdirSync(join(dir, 'slots', '.lock'), { recursive: true });
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(dir, 'slots', '.lock'), old, old);
    expect(tryTakeSlot('a', 1, dir, probe())).toBe(1);
  });

  test("another taker's fresh lock: waits about a second, then answers no slot rather than take one", () => {
    const dir = cache();
    mkdirSync(join(dir, 'slots', '.lock'), { recursive: true });
    const started = Date.now();
    expect(tryTakeSlot('a', 1, dir, probe())).toBeUndefined();
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  test('E2E_SLOTS: 2 by default, a whole number of 1 or more', () => {
    expect(slotCount(undefined)).toBe(2);
    expect(slotCount('3')).toBe(3);
    expect(() => slotCount('0')).toThrow(/E2E_SLOTS/);
    expect(() => slotCount('two')).toThrow(/E2E_SLOTS/);
  });
});

describe('cachedMediaPath', () => {
  test('is keyed on the ffmpeg arguments', () => {
    const dir = cache();
    const a = cachedMediaPath(['-i', 'x', '-c:v', 'libx265'], dir);
    expect(a).toMatch(new RegExp(`^${dir}/media/[0-9a-f]{16}\\.mkv$`));
    expect(cachedMediaPath(['-i', 'x', '-c:v', 'libx265'], dir)).toBe(a);
    expect(cachedMediaPath(['-i', 'x', '-c:v', 'libx264'], dir)).not.toBe(a);
  });
});
