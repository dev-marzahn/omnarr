// Loads the NZBGet fixtures (see README.md) and finds entries by their omnarr tag.
import { readFileSync } from 'node:fs';

import type { NzbgetGroup, NzbgetHistoryEntry } from '../../../src/clients/nzbget.ts';

type Fixture = 'history' | 'history-derived' | 'history-bad' | 'listgroups-fetching' | 'listgroups-halfway' | 'listgroups-uploaded' | 'loadconfig';

export function nzbgetFixture<T = NzbgetHistoryEntry>(name: Fixture): T[] {
  const text = readFileSync(new URL(`./${name}.json`, import.meta.url), 'utf8');
  return (JSON.parse(text) as { result: T[] }).result;
}

/** `testserver.json`: NZBGet 26.3's recorded answers, by case. */
export function testServerFixture(): Record<'ok' | 'authRejected' | 'unreachable', string> {
  const recorded = JSON.parse(readFileSync(new URL('./testserver.json', import.meta.url), 'utf8')) as Record<string, { result: string }>;
  return { ok: recorded.ok!.result, authRejected: recorded.authRejected!.result, unreachable: recorded.unreachable!.result };
}

export const tagOf = (entry: { Parameters: { Name: string; Value: string }[] }) => entry.Parameters.find((p) => p.Name === 'omnarr')?.Value;

/** Every recorded and derived history entry. */
export const historyEntries = () => [...nzbgetFixture('history'), ...nzbgetFixture('history-derived'), ...nzbgetFixture('history-bad')];

/** The recorded entry with this tag; throws when the fixtures don't have it. */
export function historyEntry(tag: string): NzbgetHistoryEntry {
  const entry = historyEntries().find((e) => tagOf(e) === tag);
  if (!entry) throw new Error(`no NZBGet history fixture tagged ${tag}`);
  return entry;
}

/** The entry with this tag in `listgroups-halfway.json`. */
export function queueEntry(tag: string): NzbgetGroup {
  const groups = nzbgetFixture<NzbgetGroup>('listgroups-halfway');
  const entry = groups.find((e) => tagOf(e) === tag);
  if (!entry) throw new Error(`no NZBGet queue fixture tagged ${tag}`);
  return entry;
}
