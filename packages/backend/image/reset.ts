// `docker compose exec backend reset-admin-password`: asks for
// the new password twice without echo (or reads it once with
// `--password-stdin`), then calls the internal action
// `setup/admin:resetAdminPassword` with the admin key derived in this
// container. It never prints the password.
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

import { adminApi, derivedAdminKey } from './admin.ts';

export type ResetOptions = {
  argv: string[];
  webUrl: string | undefined;
  /** Reads one entry; `prompt` is shown on a terminal only. */
  read: (prompt: string) => Promise<string>;
  run: (path: string, args: Record<string, unknown>) => Promise<unknown>;
  log: (line: string) => void;
};

export async function resetAdminPassword({ argv, webUrl, read, run, log }: ResetOptions): Promise<number> {
  const fromStdin = argv.includes('--password-stdin');
  const password = await read('New password: ');
  if (!fromStdin && (await read('New password again: ')) !== password) {
    log("The two passwords don't match. Nothing was changed.");
    return 1;
  }
  if (password.length < 8) {
    log('Use at least 8 characters. Nothing was changed.');
    return 1;
  }
  try {
    await run('setup/admin:resetAdminPassword', { password });
  } catch (error) {
    log(`The password wasn't changed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  log(`Password changed. Sign in again at ${webUrl || 'the web app'}.`);
  return 0;
}

/** The terminal's echo, through stty on the container's terminal. */
const echo = (on: boolean) => execFileSync('stty', [on ? 'echo' : '-echo'], { stdio: ['inherit', 'ignore', 'ignore'] });

/** One line from standard input; on a terminal, after the prompt and without echo. */
function lineReader(): (prompt: string) => Promise<string> {
  const lines = createInterface({ input: process.stdin, terminal: false })[Symbol.asyncIterator]();
  return async (prompt) => {
    const tty = process.stdin.isTTY;
    if (tty) {
      process.stdout.write(prompt);
      echo(false);
    }
    try {
      return ((await lines.next()).value as string | undefined) ?? '';
    } finally {
      if (tty) {
        echo(true);
        process.stdout.write('\n');
      }
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const api = adminApi('http://127.0.0.1:3210', derivedAdminKey());
  process.exitCode = await resetAdminPassword({
    argv: process.argv.slice(2),
    webUrl: process.env.OMNARR_WEB_URL,
    read: lineReader(),
    run: api.run,
    log: console.log,
  });
  process.exit();
}
