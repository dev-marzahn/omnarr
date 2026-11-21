// Sign in's copy: the error for a refused sign-in, and
// the recovery line under the form, which names the reset command.

export function signInErrorText(status: number | undefined): string {
  if (status === 401) return 'Wrong username or password.';
  if (status === 429) return 'Too many attempts. Try again in a few minutes.';
  return 'Signing in failed. Try again.';
}

/** "Forgot your password? Run `docker compose exec backend reset-admin-password` on the server." */
export const FORGOT_PASSWORD = { text: 'Forgot your password? Run', command: 'docker compose exec backend reset-admin-password', after: 'on the server.' };
