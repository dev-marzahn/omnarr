// The password page: its field checks, Better Auth's errors in words, and
// the copy about Jellyfin and the other omnarr sessions, which
// `revokeOtherSessions: true` signs out.

/** Better Auth's defaults, which omnarr keeps (authOptions.ts sets neither). */
export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 128;

export type PasswordFields = { current: string; next: string; repeat: string };
export type PasswordProblems = Partial<Record<keyof PasswordFields, string>>;

const TOO_SHORT = `Use at least ${MIN_PASSWORD} characters.`;
const TOO_LONG = `Use at most ${MAX_PASSWORD} characters.`;

/** The checks shown under each field before the change is sent. An empty repeat field says nothing yet. */
export function passwordProblems(fields: PasswordFields): PasswordProblems {
  const problems: PasswordProblems = {};
  if (fields.current === '') problems.current = 'Enter your current password.';
  if (fields.next.length < MIN_PASSWORD) problems.next = TOO_SHORT;
  else if (fields.next.length > MAX_PASSWORD) problems.next = TOO_LONG;
  if (fields.repeat !== '' && fields.repeat !== fields.next) problems.repeat = "The new passwords don't match.";
  return problems;
}

/** A refused `/change-password`, under its field or for the form. */
export function changeErrorText(error: { code?: string; status?: number }): { field?: keyof PasswordFields; text: string } {
  if (error.code === 'INVALID_PASSWORD') return { field: 'current', text: 'The current password is wrong.' };
  if (error.code === 'PASSWORD_TOO_SHORT') return { field: 'next', text: TOO_SHORT };
  if (error.code === 'PASSWORD_TOO_LONG') return { field: 'next', text: TOO_LONG };
  return { text: "The password couldn't be changed. Try again." };
}

/** Before the button. */
export const BEFORE_CHANGE = {
  title: 'Jellyfin will sign you out on your devices.',
  description: 'Sign in again with your new password. omnarr signs you out in your other browsers too; this one stays signed in.',
};

/** After a change. */
export const CHANGED = {
  title: 'Password changed.',
  description: 'Jellyfin has signed you out on your devices, and omnarr in your other browsers. Sign in there with your new password.',
};
