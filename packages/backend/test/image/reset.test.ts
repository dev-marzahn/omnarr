// `reset-admin-password`.
import { expect, test } from 'vite-plus/test';

import { resetAdminPassword } from '../../image/reset.ts';

const PASSWORD = 'planted-new-password';

const run = async (entries: string[], { argv = [] as string[], webUrl = undefined as string | undefined } = {}) => {
  const lines: string[] = [];
  const calls: { path: string; args: unknown }[] = [];
  const code = await resetAdminPassword({
    argv,
    webUrl,
    read: async () => entries.shift() ?? '',
    run: async (path, args) => void calls.push({ path, args }),
    log: (line) => lines.push(line),
  });
  return { code, calls, output: lines.join('\n') };
};

test('two matching entries reset the password, and the password is never printed', async () => {
  const { code, calls, output } = await run([PASSWORD, PASSWORD]);
  expect(code).toBe(0);
  expect(calls).toEqual([{ path: 'setup/admin:resetAdminPassword', args: { password: PASSWORD } }]);
  expect(output).toContain('Password changed. Sign in again at the web app.');
  expect(output).not.toContain(PASSWORD);
});

test('the success line names the web URL when one is set', async () => {
  expect((await run([PASSWORD, PASSWORD], { webUrl: 'https://omnarr.example.net' })).output).toContain('Sign in again at https://omnarr.example.net.');
});

test('mismatched entries are refused, and nothing is changed', async () => {
  const { code, calls, output } = await run([PASSWORD, `${PASSWORD}x`]);
  expect(code).toBe(1);
  expect(calls).toEqual([]);
  expect(output).toContain("The two passwords don't match.");
  expect(output).not.toContain(PASSWORD);
});

test('a password under 8 characters is refused', async () => {
  const { code, calls, output } = await run(['short', 'short']);
  expect(code).toBe(1);
  expect(calls).toEqual([]);
  expect(output).toContain('Use at least 8 characters.');
});

test('--password-stdin reads it once', async () => {
  const { code, calls } = await run([PASSWORD], { argv: ['--password-stdin'] });
  expect(code).toBe(0);
  expect(calls).toHaveLength(1);
});
