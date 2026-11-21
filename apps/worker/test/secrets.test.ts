// readSecret: the control secrets the setup container wrote.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vite-plus/test';

import { readSecret, readWorkerToken, secretsDir } from '../src/secrets.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'omnarr-secrets-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('reads the file and trims trailing whitespace', () => {
  writeFileSync(join(dir, 'nzbget_control_password'), 'c0ntr0l-secret\n');
  expect(readSecret('nzbget_control_password', dir)).toBe('c0ntr0l-secret');
});

test('a missing file fails with the secret name and the folder', () => {
  expect(() => readSecret('nzbget_control_password', dir)).toThrow(`The secret nzbget_control_password is missing from ${dir}.`);
});

test('an empty file fails without printing anything of the file', () => {
  writeFileSync(join(dir, 'nzbget_control_password'), '  \n');
  expect(() => readSecret('nzbget_control_password', dir)).toThrow(`The secret nzbget_control_password in ${dir} is empty.`);
});

test('the worker token: WORKER_TOKEN when set, else WORKER_TOKEN_FILE', () => {
  writeFileSync(join(dir, 'worker_token'), 'from-file\n');
  expect(readWorkerToken({ WORKER_TOKEN_FILE: join(dir, 'worker_token') })).toBe('from-file');
  expect(readWorkerToken({ WORKER_TOKEN: 'from-env', WORKER_TOKEN_FILE: join(dir, 'worker_token') })).toBe('from-env');
});

test("a missing token file's error names the path", () => {
  expect(() => readWorkerToken({ WORKER_TOKEN_FILE: join(dir, 'worker_token') })).toThrow(
    `The worker token file ${join(dir, 'worker_token')} is missing or empty.`,
  );
});

test('the folder is OMNARR_SECRETS_DIR, or /run/omnarr/secrets', () => {
  expect(secretsDir({})).toBe('/run/omnarr/secrets');
  expect(secretsDir({ OMNARR_SECRETS_DIR: dir })).toBe(dir);
});
