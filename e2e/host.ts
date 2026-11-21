// What the e2e runs of every checkout on one Docker host share: the compose
// project's default name (one per checkout), the host-wide slots that cap how
// many stacks run at once, and the cache of generated media. No imports
// beyond node's, so run.ts can load it.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The compose project's default name for a checkout folder: `omnarr-e2e-<folder>`, lowercased, with
 * anything compose doesn't take as `-`, and short enough for an image tag.
 */
export function projectFor(folder: string): string {
  const slug = folder
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 40)
    .replace(/[-_]+$/, '');
  return slug ? `omnarr-e2e-${slug}` : 'omnarr-e2e';
}

/** The compose project: `E2E_PROJECT`, or one per checkout, so two worktrees' runs on one host never meet. */
export const PROJECT = process.env.E2E_PROJECT || projectFor(basename(root));

/** What every checkout's runs share on this host: the slots and the generated media. */
export const CACHE = process.env.E2E_CACHE || join(homedir(), '.cache/omnarr-e2e');

/** A slot's holder, in `<slot>/owner.json`. */
export type SlotOwner = { project: string; pid: number; at: number };

/** Whether the holder still holds its slot: its run is alive, or its stack still has containers (`E2E_KEEP`). */
export type SlotProbe = { alive: (pid: number) => boolean; running: (project: string) => boolean; now: () => number };

/** A slot dir without an owner file yet is being taken; after this long it was left behind half made. */
const UNOWNED_MS = 60_000;

const realProbe: SlotProbe = {
  alive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
  running: (project) => {
    try {
      return execFileSync('docker', ['ps', '-q', '--filter', `label=com.docker.compose.project=${project}`], { encoding: 'utf8' }).trim() !== '';
    } catch {
      // No answer from Docker: keep the slot rather than start a sixth stack.
      return true;
    }
  },
  now: Date.now,
};

const slotsDir = (cache: string) => join(cache, 'slots');

function readOwner(dir: string): SlotOwner | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, 'owner.json'), 'utf8')) as SlotOwner;
  } catch {
    return undefined;
  }
}

/**
 * Takes one of `count` slots for `project` (an atomic `mkdir` of `<cache>/slots/<n>`) and answers its
 * number, or answers the project's own slot if it holds one already (a kept stack's next run). A slot
 * whose run ended and whose stack is gone is free again. Answers `undefined` when every slot is held.
 */
export function tryTakeSlot(project: string, count: number, cache = CACHE, probe: SlotProbe = realProbe): number | undefined {
  mkdirSync(slotsDir(cache), { recursive: true });
  // One taker at a time, so two runs can't both clear the same stale slot and one then lose the slot it took.
  const lock = join(slotsDir(cache), '.lock');
  // A take is a few file operations, so another run's lock is gone within milliseconds: wait for it up to a
  // second rather than report every slot held.
  for (let tries = 0; ; tries++) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      // A taker that died mid-take left it.
      if (probe.now() - (statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? probe.now()) > 30_000) rmSync(lock, { recursive: true, force: true });
      else if (tries >= 20) return undefined;
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    return takeFree(project, count, cache, probe);
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function takeFree(project: string, count: number, cache: string, probe: SlotProbe): number | undefined {
  for (let n = 1; n <= count; n++) {
    const owner = readOwner(join(slotsDir(cache), String(n)));
    if (owner?.project === project) {
      writeFileSync(join(slotsDir(cache), String(n), 'owner.json'), JSON.stringify({ project, pid: process.pid, at: probe.now() }));
      return n;
    }
  }
  for (let n = 1; n <= count; n++) {
    const dir = join(slotsDir(cache), String(n));
    if (stale(dir, probe)) rmSync(dir, { recursive: true, force: true });
    try {
      mkdirSync(dir);
    } catch {
      continue;
    }
    writeFileSync(join(dir, 'owner.json'), JSON.stringify({ project, pid: process.pid, at: probe.now() } satisfies SlotOwner));
    return n;
  }
  return undefined;
}

function stale(dir: string, probe: SlotProbe): boolean {
  let made: number;
  try {
    made = statSync(dir).mtimeMs;
  } catch {
    return false;
  }
  const owner = readOwner(dir);
  if (!owner) return probe.now() - made > UNOWNED_MS;
  return !probe.alive(owner.pid) && !probe.running(owner.project);
}

/** The projects holding the slots, for the waiting message. */
export function slotHolders(cache = CACHE): string[] {
  try {
    return readdirSync(slotsDir(cache)).flatMap((n) => readOwner(join(slotsDir(cache), n))?.project ?? []);
  } catch {
    return [];
  }
}

/** Frees the project's slot, if it holds one: run.ts at its end, or `down()` for a kept stack. */
export function releaseSlot(project: string, cache = CACHE): void {
  let names: string[];
  try {
    names = readdirSync(slotsDir(cache));
  } catch {
    return;
  }
  for (const n of names) if (readOwner(join(slotsDir(cache), n))?.project === project) rmSync(join(slotsDir(cache), n), { recursive: true, force: true });
}

/** `E2E_SLOTS`, default 2: as many stacks as the 8 GB Docker VM runs at once without starving them. */
export const slotCount = (raw = process.env.E2E_SLOTS): number => {
  const n = Number(raw || 2);
  if (!Number.isInteger(n) || n < 1) throw new Error(`E2E_SLOTS must be a whole number of 1 or more, not ${raw}.`);
  return n;
};

/** Waits for a slot, saying once that it waits and for whom, then answers its number. */
export async function takeSlot(project = PROJECT, count = slotCount(), log = (line: string) => console.log(line)): Promise<number> {
  const started = Date.now();
  let said = false;
  for (;;) {
    const slot = tryTakeSlot(project, count);
    if (slot !== undefined) {
      if (said) log(`e2e: slot ${slot} of ${count} after ${((Date.now() - started) / 1000).toFixed(0)} s`);
      return slot;
    }
    if (!said) log(`e2e: waiting for a slot: all ${count} held (${slotHolders().join(', ')}); E2E_SLOTS sets how many`);
    said = true;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

/** The cached file for a generated medium, keyed on its ffmpeg arguments: `<cache>/media/<hash>.mkv`. */
export const cachedMediaPath = (ffmpegArgs: readonly string[], cache = CACHE): string =>
  join(cache, 'media', `${createHash('sha256').update(JSON.stringify(ffmpegArgs)).digest('hex').slice(0, 16)}.mkv`);
