// The subscribe panel's defaults and its consequence line.
import type { LibraryRef, NumberingScheme, ReleaseProfileSummary, WorkPreview } from '@omnarr/contracts';

/**
 * The release profile the panel preselects: the library's
 * default, or the shipped `anime-1080p` profile when numbering is anime.
 */
export function preselectProfile(
  profiles: readonly ReleaseProfileSummary[],
  library: Pick<LibraryRef, 'defaultReleaseProfileId'>,
  numbering: NumberingScheme,
): string {
  const anime = numbering === 'anime' ? profiles.find((profile) => profile.shippedKey === 'anime-1080p') : undefined;
  return anime?.id ?? library.defaultReleaseProfileId;
}

/** The consequence line: subscribing searches the aired, monitored episodes at once. */
export function searchLine(aired: number, kind: 'series' | 'movie'): string {
  if (kind === 'movie') return 'The movie will be searched now if it is out, else from its release date';
  return `${aired} aired ${aired === 1 ? 'episode' : 'episodes'} will be searched now`;
}

/** Every season but specials, which start unmonitored. */
export const defaultSeasons = (preview: WorkPreview): number[] => preview.seasons.filter((s) => s.season !== 0).map((s) => s.season);

/** How many aired episodes the chosen seasons monitor. */
export const airedMonitored = (preview: WorkPreview, seasons: number[]): number =>
  preview.seasons.filter((s) => seasons.includes(s.season)).reduce((sum, s) => sum + s.aired, 0);

export function seasonLine(season: WorkPreview['seasons'][number], formatDate: (utc: number) => string): string {
  const episodes = `${season.episodes} ${season.episodes === 1 ? 'episode' : 'episodes'}`;
  if (season.aired === season.episodes) return `${episodes} · all aired`;
  const next = season.nextAirDateUtc === undefined ? '' : ` · next airs ${formatDate(season.nextAirDateUtc)}`;
  return `${episodes} · ${season.aired} aired${next}`;
}
