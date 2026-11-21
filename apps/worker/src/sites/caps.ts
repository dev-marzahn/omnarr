// A definition's caps: built from its metadata, as the backend builds
// them at create and at each sync (contracts' capsFromMeta).
import { capsFromMeta, type IndexerCaps } from '@omnarr/contracts';

import { metaOf } from './check.ts';
import type { Definition } from './definition.ts';

export const buildCaps = (definition: Definition, now: number): IndexerCaps => capsFromMeta(metaOf(definition), now);
