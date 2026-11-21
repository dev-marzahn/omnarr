// The child-process runner for preparation: runs
// ffmpeg (optionally under `nice -n 10`) with no shell, turns `-progress
// pipe:1` into fractions, kills a child whose `out_time_us` stops advancing,
// keeps every child's stderr in the job's `ffmpeg.log`, and stops the child on
// the abort signal. Also the output check. The job handler
// (jobs/prepare.ts) builds on both.
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';

import { type Comparison, compare, DEFAULT_LIMITS, type FailureCode, type ProbeSummary, type TargetFormat } from '@omnarr/contracts';

import { JobFailure } from '../runtime/lease.ts';

/** How many stderr lines a failure carries in the Issue's detail. */
export const LAST_LINES = 50;
/** After SIGTERM, how long a child gets to exit before SIGKILL. */
const KILL_GRACE_MS = 5000;

export type RunOptions = {
  /** `ffmpeg`, or an absolute path. Arguments are passed as they are, never through a shell. */
  command: string;
  args: string[];
  signal: AbortSignal;
  /** The job's `ffmpeg.log`: this child's stderr is appended after a `$ command args` line. */
  logPath: string;
  /** Run under `nice -n 10` (the main ffmpeg run). */
  nice?: boolean;
  /** The source's duration, which turns `out_time_us` into fractions. */
  durationMs?: number;
  onProgress?: (fraction: number) => void;
  /** Kill the child when `out_time_us` hasn't advanced for this long (`ffmpegStallMs`). */
  stallMs?: number;
};

/** A child that failed: exited non-zero, was killed by a signal, or stalled. */
export class ChildFailure extends JobFailure {
  public constructor(
    code: FailureCode,
    detail: string,
    /** null when the child was killed by a signal (or by the watchdog). */
    public readonly exitCode: number | null,
    public readonly lastLines: string[],
    public readonly logPath: string,
  ) {
    super(code, detail);
  }
}

const seconds = (ms: number) => `${Math.round(ms / 100) / 10} s`;

/**
 * Runs one child to completion. Resolves on exit code 0. Rejects with the
 * signal's reason after an abort (once the child is gone), with a
 * `JobFailure('pipelineError')` for a missing binary, and with a
 * `ChildFailure` otherwise: `diskFull` when stderr says the disk is full,
 * else `transcodeFailed`.
 */
export async function runChild(options: RunOptions): Promise<void> {
  const { command, args, signal, logPath } = options;
  if (signal.aborted) throw signal.reason;
  const stallMs = options.stallMs ?? DEFAULT_LIMITS.ffmpegStallMs;
  const [file, argv] = options.nice ? ['nice', ['-n', '10', command, ...args]] : [command, args];

  const log = createWriteStream(logPath, { flags: 'a' });
  log.write(`$ ${command} ${args.join(' ')}\n`);
  const closeLog = () => new Promise<void>((resolve) => log.end(resolve));

  const child = spawn(file, argv, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  const lastLines: string[] = [];
  let stderrRest = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    log.write(chunk);
    const lines = (stderrRest + chunk).split(/\r?\n|\r/);
    stderrRest = lines.pop() ?? '';
    for (const line of lines) if (line) lastLines.push(line);
    if (lastLines.length > LAST_LINES) lastLines.splice(0, lastLines.length - LAST_LINES);
  });

  let stalled = false;
  let lastOutTime = -1;
  let watchdog: NodeJS.Timeout | undefined;
  const arm = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      stalled = true;
      child.kill('SIGKILL');
    }, stallMs);
  };
  arm();

  let stdoutRest = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    const lines = (stdoutRest + chunk).split('\n');
    stdoutRest = lines.pop() ?? '';
    for (const line of lines) {
      const match = /^out_time_us=(\d+)$/.exec(line.trim());
      if (!match) continue;
      const outTime = Number(match[1]);
      if (outTime <= lastOutTime) continue;
      lastOutTime = outTime;
      arm();
      if (options.onProgress && options.durationMs) options.onProgress(Math.min(1, outTime / 1000 / options.durationMs));
    }
  });

  let graceTimer: NodeJS.Timeout | undefined;
  const onAbort = () => {
    child.kill('SIGTERM');
    graceTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
  };
  signal.addEventListener('abort', onAbort, { once: true });

  const outcome = await new Promise<{ code: number | null; signalName: NodeJS.Signals | null } | { error: NodeJS.ErrnoException }>((resolve) => {
    child.once('error', (error: NodeJS.ErrnoException) => resolve({ error }));
    child.once('close', (code, signalName) => resolve({ code, signalName }));
  });
  clearTimeout(watchdog);
  clearTimeout(graceTimer);
  signal.removeEventListener('abort', onAbort);
  if (stderrRest) lastLines.push(stderrRest);
  if (lastLines.length > LAST_LINES) lastLines.splice(0, lastLines.length - LAST_LINES);
  await closeLog();

  if ('error' in outcome) {
    if (outcome.error.code === 'ENOENT') throw new JobFailure('pipelineError', `${file === 'nice' ? 'nice' : command} is not installed in the worker.`);
    throw outcome.error;
  }
  if (signal.aborted) throw signal.reason;
  const { code, signalName } = outcome;
  if (code === 0 && !stalled) return;
  // nice exits 127 when it can't find the command.
  if (options.nice && code === 127) throw new JobFailure('pipelineError', `${command} is not installed in the worker.`);

  const name = command.split('/').pop() ?? command;
  const why = stalled
    ? `${name} stalled: out_time_us didn't advance for ${seconds(stallMs)}.`
    : code === null
      ? `${name} was killed by ${signalName ?? 'a signal'}.`
      : `${name} exited with code ${code}.`;
  const failure: FailureCode = lastLines.some((line) => line.includes('No space left on device')) ? 'diskFull' : 'transcodeFailed';
  const detail = lastLines.length > 0 ? `${why} Last ${lastLines.length} lines of its log:\n${lastLines.join('\n')}` : why;
  throw new ChildFailure(failure, detail, stalled ? null : code, [...lastLines], logPath);
}

/**
 * The prepared output must fit the target by `compare`, last as
 * long as the source within max(`durationToleranceMs`, `durationToleranceRatio`
 * × the source's duration), and hold the planned video stream and as many
 * audio streams as the plan keeps. Otherwise `transcodeFailed` with
 * "Output check failed: <reason>".
 */
export function checkOutput(sourceProbe: ProbeSummary, outputProbe: ProbeSummary, target: TargetFormat, plan: Comparison): void {
  const failed = (reason: string) => new JobFailure('transcodeFailed', `Output check failed: ${reason}.`);
  const planned = (kind: 'video' | 'audio') => plan.streams.filter((stream) => stream.kind === kind && stream.action !== 'drop').length;
  const found = (kind: 'video' | 'audio') => outputProbe.streams.filter((stream) => stream.kind === kind).length;
  if (planned('video') > 0 && found('video') === 0) throw failed('it has no video stream');
  if (found('audio') !== planned('audio')) throw failed(`it has ${found('audio')} audio streams; the plan has ${planned('audio')}`);
  const comparison = compare(outputProbe, target);
  if (!comparison.fits) throw failed(`it doesn't fit the target (${comparison.steps.join(', ')})`);
  const source = sourceProbe.durationMs;
  if (source !== undefined) {
    const output = outputProbe.durationMs;
    const tolerance = Math.max(DEFAULT_LIMITS.durationToleranceMs, DEFAULT_LIMITS.durationToleranceRatio * source);
    if (output === undefined) throw failed('it has no duration');
    if (Math.abs(output - source) > tolerance) throw failed(`its duration is ${seconds(output)}, the source's ${seconds(source)}`);
  }
}
