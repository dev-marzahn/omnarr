// Shipped version 2, frozen: reference seed 0002 imports it. Version 1 with
// `preferSeasonPacks` on; every other field is v1's.
// Never edit; a content change is a new `v<N>/` module and a new seed.
import type { ReleaseProfileContent } from '@omnarr/contracts';

import * as v1 from '../v1/index.ts';

const preferringPacks = (content: ReleaseProfileContent): ReleaseProfileContent => ({ ...content, preferSeasonPacks: true });

export const web1080p = preferringPacks(v1.web1080p);
export const uhd2160p = preferringPacks(v1.uhd2160p);
export const anime1080p = preferringPacks(v1.anime1080p);
