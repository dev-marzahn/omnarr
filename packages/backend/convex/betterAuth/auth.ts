// Only for the Better Auth CLI, which reads this instance to generate
// schema.ts. Run `bun run auth:schema` in packages/backend after changing
// ../authOptions.ts. Nothing imports this file at runtime.
import { betterAuth } from 'better-auth';

import { staticAuthOptions } from '../authOptions';

export const auth = betterAuth(staticAuthOptions());
