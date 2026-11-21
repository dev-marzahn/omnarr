// What the first-run pages share: the step list the layout shows, and
// moving to a later step, which `setup.advance` records first so a closed tab
// resumes there.
import { api } from '@omnarr/backend/api';
import type { FirstRunStep } from '@omnarr/contracts';

import { FRAME_PATH } from '~/lib/firstRun';

export const SETUP_STEPS: { key: Exclude<FirstRunStep, 'done'>; label: string; note?: string }[] = [
  { key: 'account', label: 'Account' },
  { key: 'address', label: 'Address' },
  { key: 'indexer', label: 'Indexer' },
  { key: 'usenet', label: 'Usenet provider' },
  { key: 'torrents', label: 'Torrents', note: 'optional' },
  { key: 'devices', label: 'Devices' },
  { key: 'metadata', label: 'Metadata', note: 'optional' },
  { key: 'finish', label: 'Finish' },
  { key: 'existingMedia', label: 'Existing media', note: 'if found' },
];

/** Records `step` and opens its frame (or `to`, after `done`). */
export function useAdvance() {
  const advance = useMutation(api.api.setup.advance);
  return async (step: FirstRunStep, to?: string) => {
    await advance({ step });
    await navigateTo(to ?? (step === 'done' ? '/library' : FRAME_PATH[step]));
  };
}
