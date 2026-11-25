// Wording for the metadata screens: the add-title modal, the Work page's
// numbering panel and Settings › Metadata. Kept here, not in .vue files, so
// `vp check` type-checks it.
import type { AliasSource, MappingSource, MappingStatus, MetadataSettingsRow, NumberingReason, WorkMetadataRow } from '@omnarr/contracts';

/** TMDB's attribution notice, from TMDB's current terms. */
export const TMDB_NOTICE = 'This product uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB.';

/** The tag beside a preselected numbering scheme; none when nothing suggested anime. */
export const NUMBERING_REASON: Record<NumberingReason, string | undefined> = {
  animeLists: 'From Anime-Lists',
  genreOrigin: 'From TMDB genre and origin',
  none: undefined,
};

export const MAPPING_STATUS: Record<MappingStatus, { label: string; color: 'success' | 'warning' | 'neutral'; description: string }> = {
  complete: { label: 'Numbering mapped', color: 'success', description: 'Scene and TVDB numbers are linked to every TMDB episode.' },
  partial: {
    label: 'Numbering partly mapped',
    color: 'warning',
    description: 'Some scene or TVDB numbers could not be linked. Releases with those numbers are matched by TMDB numbers, marked unverified.',
  },
  tmdbOnly: { label: 'TMDB numbering', color: 'neutral', description: 'No mapping data lists this title, so releases are assumed to follow TMDB numbers.' },
};

export const ALIAS_SOURCE: Record<AliasSource, string> = {
  tmdb: 'TMDB',
  animeLists: 'Anime-Lists',
  xem: 'TheXEM',
  sceneMapping: 'Sonarr scene mappings',
  manual: 'Added by you',
};
export const MAPPING_SOURCE: Record<MappingSource, string> = { tmdb: 'TMDB', tvdb: 'TVDB', xem: 'TheXEM', animeLists: 'Anime-Lists', manual: 'Manual' };

/** A mapping row's numbers: `S01E13`, `#13`, or both. */
export function mappingNumbers(row: { season?: number; episode?: number; absolute?: number }): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const se = row.season !== undefined && row.episode !== undefined ? `S${pad(row.season)}E${pad(row.episode)}` : undefined;
  const abs = row.absolute !== undefined ? `#${row.absolute}` : undefined;
  return [se, abs].filter(Boolean).join(' · ');
}

/** What the Work page says about a Work's first write and TMDB listing, if anything. */
export function buildNotice(info: Pick<WorkMetadataRow, 'buildState' | 'tmdbMissing'>): { title: string; color: 'error' | 'warning' | 'neutral' } | undefined {
  if (info.buildState === 'failed') return { title: "Couldn't load episodes from TMDB", color: 'error' };
  if (info.buildState === 'building') return { title: 'Loading episodes from TMDB…', color: 'neutral' };
  if (info.tmdbMissing) return { title: 'TMDB no longer lists this title. Its episodes and files stay.', color: 'warning' };
  return undefined;
}

/** The message for a metadata call that failed, by the backend's error code. */
export function metadataErrorText(code: string | undefined, tokenSource: 'user' | 'deployment' | undefined = 'deployment'): string {
  if (code === 'metadataKeyRejected')
    return tokenSource === 'user' ? 'TMDB rejected your token. Enter a new one in Settings › Metadata.' : 'TMDB rejected the built-in token.';
  if (code === 'metadataUnavailable' || code === 'metadataBadResponse') return "Couldn't reach TMDB. Your library and downloads aren't affected.";
  return 'Something went wrong. Try again.';
}

export type SourceHealth = { badge: { label: string; color: 'success' | 'error' | 'neutral' }; line: string; failing?: true };

/** A source's row in Settings › Metadata: one health badge and one line. */
export function sourceHealth(source: MetadataSettingsRow['sources'][number], formatTime: (ms: number) => string): SourceHealth {
  const last = source.lastSuccessAt === undefined ? undefined : formatTime(source.lastSuccessAt);
  if (source.firstFailureAt !== undefined)
    return {
      badge: { label: 'Failing', color: 'error' },
      line: [`Failing since ${formatTime(source.firstFailureAt)}`, ...(last ? [`last success ${last}`] : [])].join(' · '),
      failing: true,
    };
  if (last)
    return {
      badge: { label: 'Working', color: 'success' },
      line: [`Last success ${last}`, ...(source.version ? [`version ${source.version.slice(0, 19)}`] : [])].join(' · '),
    };
  return { badge: { label: 'Not fetched yet', color: 'neutral' }, line: 'Fetched on its first use' };
}
