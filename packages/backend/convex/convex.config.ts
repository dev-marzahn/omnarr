import migrations from '@convex-dev/migrations/convex.config';
import workflow from '@convex-dev/workflow/convex.config';
import workpool from '@convex-dev/workpool/convex.config';
import workflowMigrations from '@dev-marzahn/convex-workflow-migrations/convex.config.js';
import { defineApp } from 'convex/server';

// The Better Auth component is installed locally (convex/betterAuth/), because
// the admin plugin's fields aren't in the packaged component's schema.
import betterAuth from './betterAuth/convex.config';

const app = defineApp();
app.use(workflow);
app.use(workflowMigrations);
app.use(betterAuth);
app.use(migrations);
// Every background metadata sync and mapping-source fetch.
app.use(workpool, { name: 'metadataPool' });
export default app;
