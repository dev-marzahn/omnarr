// The media fixtures' folder, and whether the real tools the media tests run
// (ffmpeg, ffprobe, unar, lsar) are installed. A missing tool skips its tests
// with a notice, unless OMNARR_REQUIRE_MEDIA_TOOLS=1 (CI's worker-image job),
// where it fails them.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const MEDIA = fileURLToPath(new URL('.', import.meta.url));

/** True when every named tool runs; false (with a notice) or a throw when one is missing. */
export function mediaTools(...names: string[]): boolean {
  const missing = names.filter((name) => (spawnSync(name, ['-h'], { stdio: 'ignore' }).error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT');
  if (missing.length === 0) return true;
  if (process.env.OMNARR_REQUIRE_MEDIA_TOOLS === '1')
    throw new Error(`OMNARR_REQUIRE_MEDIA_TOOLS=1, but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not installed.`);
  // Straight to stderr: the test runner doesn't show console output from collection.
  process.stderr.write(`NOTICE: skipping the tests that need ${missing.join(', ')}: not installed. Set OMNARR_REQUIRE_MEDIA_TOOLS=1 to require them.\n`);
  return false;
}
