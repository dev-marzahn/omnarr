// A setup file of the scenarios (vite.e2e.config.ts): a failed test marks the
// run, so stack.ts's down() writes the failure dump before the stack goes,
// and the tests that need it skip (stack.ts's after()).
import { beforeEach } from 'vite-plus/test';

import { markFailed } from './stack.ts';

beforeEach(({ onTestFailed, task }) => {
  onTestFailed(() => markFailed(task.name));
});
