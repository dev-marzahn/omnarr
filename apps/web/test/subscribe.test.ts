// The subscribe panel's profile choice and its consequence line.
import type { LibraryRef, ReleaseProfileSummary } from '@omnarr/contracts';
import { expect, test } from 'vite-plus/test';

import { preselectProfile, searchLine } from '../lib/subscribe';

const profiles = [
  { id: 'web', name: '1080p WEB', shippedKey: 'web-1080p' },
  { id: 'anime', name: 'Anime 1080p', shippedKey: 'anime-1080p' },
  { id: 'mine', name: 'Mine' },
] as unknown as ReleaseProfileSummary[];
const library = { defaultReleaseProfileId: 'mine' } as unknown as LibraryRef;

test("the library's default profile, or the shipped anime profile when numbering is anime", () => {
  expect(preselectProfile(profiles, library, 'standard')).toBe('mine');
  expect(preselectProfile(profiles, library, 'anime')).toBe('anime');
  expect(preselectProfile(profiles.slice(0, 1), library, 'anime')).toBe('mine');
});

test('the line says how many aired episodes are searched now', () => {
  expect(searchLine(5, 'series')).toBe('5 aired episodes will be searched now');
  expect(searchLine(1, 'series')).toBe('1 aired episode will be searched now');
  // The movie preview has no release date, so the line covers both cases.
  expect(searchLine(0, 'movie')).toBe('The movie will be searched now if it is out, else from its release date');
});
