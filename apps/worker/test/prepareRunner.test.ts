// The child-process runner for ffmpeg: progress from
// `-progress pipe:1`, the stall watchdog, abort, `ffmpeg.log` and the last 50
// lines on failure. The children are small Node scripts standing in for ffmpeg.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vite-plus/test';

import { ChildFailure, runChild } from '../src/media/prepare.ts';
import { JobFailure } from '../src/runtime/lease.ts';

let dir: string;
let log: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'omnarr-runner-'));
  log = join(dir, 'ffmpeg.log');
});
afterEach(() => rm(dir, { recursive: true, force: true }));

/** A stand-in child: a Node script with this body. */
async function script(body: string): Promise<string[]> {
  const path = join(dir, `child-${Math.random().toString(36).slice(2)}.cjs`);
  await writeFile(path, body);
  return [path];
}
const node = process.execPath;
const signal = () => new AbortController().signal;

test('out_time_us over the source duration gives the progress fractions; N/A is skipped', async () => {
  const args = await script(`
    process.stdout.write('frame=1\\nout_time_us=N/A\\nprogress=continue\\n');
    process.stdout.write('out_time_us=500000\\nprogress=continue\\nout_ti');
    setTimeout(() => process.stdout.write('me_us=1500000\\nprogress=continue\\nout_time_us=2600000\\nprogress=end\\n'), 50);
  `);
  const fractions: number[] = [];
  await runChild({ command: node, args, signal: signal(), logPath: log, durationMs: 2000, onProgress: (f) => fractions.push(f) });
  expect(fractions).toEqual([0.25, 0.75, 1]);
});

test('the watchdog kills a child whose out_time_us stops advancing', async () => {
  const args = await script(`
    process.stdout.write('out_time_us=100000\\nprogress=continue\\n');
    setInterval(() => process.stdout.write('out_time_us=100000\\nprogress=continue\\n'), 50);
  `);
  const started = Date.now();
  const error = await runChild({ command: node, args, signal: signal(), logPath: log, durationMs: 1000, stallMs: 300 }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ChildFailure);
  expect(error).toMatchObject({ code: 'transcodeFailed', exitCode: null });
  expect((error as ChildFailure).detail).toMatch(/^node stalled: out_time_us didn't advance for 0\.3 s\./);
  expect(Date.now() - started).toBeLessThan(3000);
});

test('the watchdog fires on a child that prints nothing at all', async () => {
  const args = await script('setTimeout(() => {}, 60000);');
  const error = await runChild({ command: node, args, signal: signal(), logPath: log, stallMs: 200 }).catch((e: unknown) => e);
  expect(error).toMatchObject({ code: 'transcodeFailed' });
});

test('a child that keeps advancing outlives the stall limit', async () => {
  const args = await script(`
    let t = 0;
    const timer = setInterval(() => { t += 100000; process.stdout.write('out_time_us=' + t + '\\n'); if (t >= 800000) { clearInterval(timer); } }, 60);
  `);
  await expect(runChild({ command: node, args, signal: signal(), logPath: log, durationMs: 1000, stallMs: 250 })).resolves.toBeUndefined();
});

test('the abort signal stops the child, and the run rejects with its reason once the child is gone', async () => {
  const pidFile = join(dir, 'pid');
  const args = await script(`require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60000);`);
  const controller = new AbortController();
  const run = runChild({ command: node, args, signal: controller.signal, logPath: log });
  for (let i = 0; i < 100 && !(await readFile(pidFile, 'utf8').catch(() => '')); i++) await new Promise((r) => setTimeout(r, 20));
  const pid = Number(await readFile(pidFile, 'utf8'));
  controller.abort('cancelled');
  await expect(run).rejects.toBe('cancelled');
  expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
});

test('an already aborted signal starts nothing', async () => {
  const marker = join(dir, 'ran');
  const args = await script(`require('fs').writeFileSync(${JSON.stringify(marker)}, '1');`);
  const controller = new AbortController();
  controller.abort('lostLease');
  await expect(runChild({ command: node, args, signal: controller.signal, logPath: log })).rejects.toBe('lostLease');
  await expect(readFile(marker, 'utf8')).rejects.toThrow();
});

test("every child's stderr is kept in the log, one run after the other", async () => {
  await runChild({ command: node, args: await script("console.error('first run'); console.error('done');"), signal: signal(), logPath: log });
  await runChild({ command: node, args: await script("console.error('second run');"), signal: signal(), logPath: log });
  const text = await readFile(log, 'utf8');
  expect(text).toMatch(/first run\ndone\n[\s\S]*second run\n/);
  expect(text.match(/^\$ .*node /gm)).toHaveLength(2);
});

test('a non-zero exit is transcodeFailed with the exit code and the last 50 lines of stderr', async () => {
  const args = await script(`for (let i = 1; i <= 60; i++) console.error('line ' + i); process.exit(3);`);
  const error = (await runChild({ command: node, args, signal: signal(), logPath: log }).catch((e: unknown) => e)) as ChildFailure;
  const last = Array.from({ length: 50 }, (_, i) => `line ${i + 11}`);
  expect(error).toBeInstanceOf(JobFailure);
  expect(error).toMatchObject({ code: 'transcodeFailed', exitCode: 3, lastLines: last, logPath: log });
  expect(error.detail).toBe(`node exited with code 3. Last 50 lines of its log:\n${last.join('\n')}`);
});

test('No space left on device in stderr is diskFull', async () => {
  const args = await script(`console.error('[out#0/mp4] Error writing trailer: No space left on device'); process.exit(1);`);
  await expect(runChild({ command: node, args, signal: signal(), logPath: log })).rejects.toMatchObject({ code: 'diskFull', exitCode: 1 });
});

test('a missing binary is pipelineError, with and without nice', async () => {
  const missing = join(dir, 'no-such-ffmpeg');
  await expect(runChild({ command: missing, args: [], signal: signal(), logPath: log })).rejects.toEqual(
    new JobFailure('pipelineError', `${missing} is not installed in the worker.`),
  );
  await expect(runChild({ command: missing, args: [], nice: true, signal: signal(), logPath: log })).rejects.toEqual(
    new JobFailure('pipelineError', `${missing} is not installed in the worker.`),
  );
});

test('nice runs the child at niceness 10', async () => {
  const args = await script("console.error('niceness ' + require('os').getPriority());");
  await runChild({ command: node, args, nice: true, signal: signal(), logPath: log });
  expect(await readFile(log, 'utf8')).toContain('niceness 10\n');
});
