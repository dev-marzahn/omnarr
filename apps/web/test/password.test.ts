// The password page: its field checks, the server's errors, and the copy about signing out of Jellyfin and other browsers.
import { describe, expect, test } from 'vite-plus/test';

import { BEFORE_CHANGE, changeErrorText, CHANGED, passwordProblems } from '../lib/password';

describe('passwordProblems', () => {
  test('nothing to say about a valid form', () => {
    expect(passwordProblems({ current: 'old-password', next: 'new-password', repeat: 'new-password' })).toEqual({});
  });

  test('a short new password, and a repeat that differs, each under its field', () => {
    expect(passwordProblems({ current: 'old', next: 'short', repeat: 'shorter' })).toEqual({
      next: 'Use at least 8 characters.',
      repeat: "The new passwords don't match.",
    });
  });

  test('the current password is needed', () => {
    expect(passwordProblems({ current: '', next: 'new-password', repeat: 'new-password' })).toEqual({ current: 'Enter your current password.' });
  });

  test('an untouched repeat field says nothing yet', () => {
    expect(passwordProblems({ current: 'x', next: 'new-password', repeat: '' })).toEqual({});
  });
});

describe('changeErrorText', () => {
  test("Better Auth's wrong current password goes under that field", () => {
    expect(changeErrorText({ code: 'INVALID_PASSWORD', status: 400 })).toEqual({ field: 'current', text: 'The current password is wrong.' });
  });

  test('too short or too long, from the server', () => {
    expect(changeErrorText({ code: 'PASSWORD_TOO_SHORT', status: 400 })).toEqual({ field: 'next', text: 'Use at least 8 characters.' });
    expect(changeErrorText({ code: 'PASSWORD_TOO_LONG', status: 400 })).toEqual({ field: 'next', text: 'Use at most 128 characters.' });
  });

  test('anything else is the form’s error', () => {
    expect(changeErrorText({ status: 500 })).toEqual({ text: "The password couldn't be changed. Try again." });
  });
});

test('the Jellyfin sign-out copy, with the line about other browsers', () => {
  expect(BEFORE_CHANGE).toEqual({
    title: 'Jellyfin will sign you out on your devices.',
    description: 'Sign in again with your new password. omnarr signs you out in your other browsers too; this one stays signed in.',
  });
  expect(CHANGED).toEqual({
    title: 'Password changed.',
    description: 'Jellyfin has signed you out on your devices, and omnarr in your other browsers. Sign in there with your new password.',
  });
});
