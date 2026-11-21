// First run's contracts: its steps and the `setup.*` functions'
// arguments and answers.
import { z } from 'zod';

/** First run's steps, in order; `settings.firstRun.step` is the furthest reached. */
export const FirstRunStep = z.enum(['account', 'address', 'indexer', 'usenet', 'torrents', 'devices', 'metadata', 'finish', 'existingMedia', 'done']);
export type FirstRunStep = z.infer<typeof FirstRunStep>;

/** `setup.state`: before an admin exists, or after; `step` only for an admin session. */
export const SetupState = z.union([
  z.object({ adminExists: z.literal(false) }).strict(),
  z.object({ adminExists: z.literal(true), step: FirstRunStep.optional() }).strict(),
]);
export type SetupState = z.infer<typeof SetupState>;

export const CreateAdminRequest = z.object({
  setupPassword: z.string(),
  username: z.string(),
  email: z.string().optional(),
  password: z.string(),
  /** The browser's locale, a BCP 47 tag (`de-DE`). */
  locale: z.string(),
});
export type CreateAdminRequest = z.infer<typeof CreateAdminRequest>;

export const CreateAdminError = z.enum(['adminExists', 'wrongSetupPassword', 'locked', 'invalidUsername', 'weakPassword']);
export type CreateAdminError = z.infer<typeof CreateAdminError>;

/** Refusals are values, never thrown; `until` comes with `locked`. */
export const CreateAdminResult = z.union([
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ error: CreateAdminError, until: z.number().optional() }).strict(),
]);
export type CreateAdminResult = z.infer<typeof CreateAdminResult>;

export const AdvanceRequest = z.object({ step: FirstRunStep });
export type AdvanceRequest = z.infer<typeof AdvanceRequest>;

export const SaveLanguageRequest = z.object({ language: z.string() });
export type SaveLanguageRequest = z.infer<typeof SaveLanguageRequest>;

/** Better Auth's username rule, which Jellyfin's allows: letters, digits, `_` and `.`, 3–30 characters. */
export const USERNAME_PATTERN = /^[a-zA-Z0-9_.]{3,30}$/;
/** Better Auth's minimum password length. */
export const MIN_PASSWORD_LENGTH = 8;
