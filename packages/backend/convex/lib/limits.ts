// The backend's limits: DEFAULT_LIMITS, with the e2e's overrides when the
// deployment sets OMNARR_TEST_LIMITS (contracts' `limitsFrom`). Read on each
// call, since a deployment's environment can change without a deploy.
import { type Limits, limitsFrom } from '@omnarr/contracts';

export const limits = (): Limits => limitsFrom(process.env.OMNARR_TEST_LIMITS);
