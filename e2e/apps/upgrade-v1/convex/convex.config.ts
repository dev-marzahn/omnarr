// The upgrade fixture's release 1: the two workflow components,
// as packages/backend mounts them.
import workflow from '@convex-dev/workflow/convex.config';
import workflowMigrations from '@dev-marzahn/convex-workflow-migrations/convex.config.js';
import { defineApp } from 'convex/server';

const app = defineApp();
app.use(workflow);
app.use(workflowMigrations);
export default app;
