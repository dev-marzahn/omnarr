// Every hand-built history of `pipelineRun` replays on the current code,
// with its migrations.
import { expectReplays } from '@dev-marzahn/convex-workflow-migrations/replay';
import { describe, test } from 'vite-plus/test';

import { pipelineRun } from '../convex/pipeline/workflow';
import { RELEASE_1 } from './histories/pipelineRun';

describe('pipelineRun replays', () => {
  test.each(Object.entries(RELEASE_1))('release 1, %s', async (_name, recorded) => {
    await expectReplays(pipelineRun, [recorded]);
  });
});
