// Sign in's copy.
import { describe, expect, test } from 'vite-plus/test';

import { FORGOT_PASSWORD, signInErrorText } from '../lib/signIn';

describe('signInErrorText', () => {
  test('wrong credentials', () => {
    expect(signInErrorText(401)).toBe('Wrong username or password.');
  });

  test('rate-limited', () => {
    expect(signInErrorText(429)).toBe('Too many attempts. Try again in a few minutes.');
  });

  test('anything else', () => {
    expect(signInErrorText(500)).toBe('Signing in failed. Try again.');
    expect(signInErrorText(undefined)).toBe('Signing in failed. Try again.');
  });
});

test('the recovery line under the form names the reset command', () => {
  expect(FORGOT_PASSWORD).toEqual({ text: 'Forgot your password? Run', command: 'docker compose exec backend reset-admin-password', after: 'on the server.' });
});
