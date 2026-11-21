// The release-profile screens' logic: badges, the update banner, the
// quality ranking with equal-rank groups, and error text.
import {
  Condition,
  EDITION_FLAGS,
  LanguageCode,
  type LanguageSpec,
  type QualityEntry,
  type QualityId,
  type ReleaseProfile,
  type ReleaseProfileSummary,
} from '@omnarr/contracts';

export function badges(summary: Pick<ReleaseProfileSummary, 'shippedKey' | 'edited' | 'updateAvailable'>): string[] {
  const list: string[] = [];
  if (summary.shippedKey) list.push('Shipped');
  if (summary.edited) list.push('Edited');
  if (summary.updateAvailable) list.push('Update available');
  return list;
}

type StoredVersion = Pick<ReleaseProfile, 'shippedKey' | 'shippedVersion' | 'editedByUser' | 'pendingShippedVersion'>;

/** The profile page's badges, from the stored profile rather than the list's summary. */
export const profileBadges = (profile: StoredVersion): string[] =>
  badges({ shippedKey: profile.shippedKey, edited: profile.editedByUser, updateAvailable: profile.pendingShippedVersion !== undefined });

/** "Shipped version 2 · updated with each release", or what an edit means; nothing for a profile the user made. */
export function versionLine(profile: StoredVersion): string | undefined {
  if (profile.shippedKey === undefined) return undefined;
  const version = `Shipped version ${profile.shippedVersion ?? '?'}`;
  return profile.editedByUser
    ? `${version} · edited. Later shipped updates won't overwrite this profile while it's edited.`
    : `${version} · updated with each release`;
}

/** "Shipped version K is available…", from `pendingShippedVersion`. */
export function pendingBanner(profile: Pick<ReleaseProfile, 'shippedVersion' | 'pendingShippedVersion'>): string | undefined {
  if (profile.pendingShippedVersion === undefined) return undefined;
  return `Shipped version ${profile.pendingShippedVersion} is available. Your edits keep this profile on version ${profile.shippedVersion ?? '?'}. Reset to apply it.`;
}

/** Allowed qualities in rank order, equal ranks grouped; the disallowed ones last, as one group. */
export function rankedGroups(qualities: readonly QualityEntry[]): QualityEntry[][] {
  const allowed = qualities.filter((q) => q.allowed);
  const ranks = [...new Set(allowed.map((q) => q.rank))].sort((a, b) => a - b);
  const groups = ranks.map((rank) => allowed.filter((q) => q.rank === rank));
  const disallowed = qualities.filter((q) => !q.allowed);
  return disallowed.length > 0 ? [...groups, disallowed] : groups;
}

/** Renumbers allowed groups 1…n in order; disallowed qualities rank after them. */
function renumber(groups: QualityEntry[][], disallowed: QualityEntry[]): QualityEntry[] {
  const ranked = groups.flatMap((group, i) => group.map((q) => ({ ...q, rank: i + 1 })));
  return [...ranked, ...disallowed.map((q, i) => ({ ...q, rank: groups.length + 1 + i }))];
}

/**
 * Moves an allowed quality one place: out of its group into a group of its
 * own just before the group above (up) or after the group below (down).
 */
export function moveQuality(qualities: readonly QualityEntry[], quality: QualityId, direction: 'up' | 'down'): QualityEntry[] {
  const groups = rankedGroups(qualities).filter((group) => group.every((q) => q.allowed));
  const disallowed = qualities.filter((q) => !q.allowed);
  const from = groups.findIndex((group) => group.some((q) => q.quality === quality));
  if (from === -1) return [...qualities];
  const entry = groups[from]!.find((q) => q.quality === quality)!;
  const rest = groups.map((group) => group.filter((q) => q.quality !== quality));
  const alone = groups[from]!.length === 1;
  // Where the quality goes, counted in `rest` (where its group may now be empty).
  const target = direction === 'up' ? (alone ? from - 1 : from) : alone ? from + 2 : from + 1;
  const index = Math.max(0, Math.min(rest.length, target));
  rest.splice(index, 0, [entry]);
  return renumber(
    rest.filter((group) => group.length > 0),
    disallowed,
  );
}

/** Allows a quality (last among the allowed) or disallows it. */
export function setAllowed(qualities: readonly QualityEntry[], quality: QualityId, allowed: boolean): QualityEntry[] {
  const groups = rankedGroups(qualities).filter((group) => group.every((q) => q.allowed));
  const disallowed = qualities.filter((q) => !q.allowed && q.quality !== quality);
  const without = groups.map((group) => group.filter((q) => q.quality !== quality)).filter((group) => group.length > 0);
  const entry = qualities.find((q) => q.quality === quality)!;
  if (allowed) return renumber([...without, [{ ...entry, allowed: true }]], disallowed);
  return renumber(without, [...disallowed, { ...entry, allowed: false }]);
}

/** A language list entry from the editor's select: the two tokens, or an ISO 639-1 code. */
export function languageSpecOf(value: string): LanguageSpec | undefined {
  if (value === 'preferred' || value === 'original') return { kind: value };
  const code = LanguageCode.safeParse(value);
  return code.success ? { kind: 'code', code: code.data } : undefined;
}

/** The user-format condition fields and the operators each takes. */
export const CONDITION_FIELDS: Record<Condition['field'], readonly string[]> = {
  source: ['in', 'notIn'],
  videoCodec: ['in', 'notIn'],
  audioCodec: ['in', 'notIn'],
  audioChannels: ['in', 'notIn'],
  streamingService: ['in', 'notIn'],
  group: ['in', 'notIn'],
  modifier: ['in', 'notIn'],
  container: ['in', 'notIn'],
  resolution: ['in', 'notIn', 'gte', 'lte'],
  bitDepth: ['in', 'notIn', 'gte', 'lte'],
  hdr: ['any', 'all', 'none'],
  languages: ['any', 'all', 'none'],
  subtitleLanguages: ['any', 'all', 'none'],
  atmos: ['is'],
  hardcodedSubs: ['is'],
  repack: ['is'],
  ...(Object.fromEntries(EDITION_FLAGS.map((flag) => [`edition.${flag}`, ['is']])) as unknown as Record<
    `edition.${(typeof EDITION_FLAGS)[number]}`,
    readonly string[]
  >),
};

const NUMBER_FIELDS = new Set(['resolution', 'bitDepth']);

/** A condition from the editor's field, operator and comma-separated values; undefined when the contract refuses it. */
export function buildCondition(field: string, op: string, text: string): Condition | undefined {
  const values = text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  const candidate = op === 'is' ? { field, op, value: text.trim() === 'true' } : { field, op, values: NUMBER_FIELDS.has(field) ? values.map(Number) : values };
  if (op !== 'is' && values.length === 0) return undefined;
  const parsed = Condition.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

export const conditionLabel = (condition: Condition): string =>
  'value' in condition ? `${condition.field} is ${condition.value}` : `${condition.field} ${condition.op} ${condition.values.join(', ')}`;

/** What the profile functions refuse with, by their error data. */
export function profileErrorText(error: unknown): string {
  const data = (error as { data?: Record<string, unknown> } | null)?.data;
  const code = typeof data?.code === 'string' ? data.code : undefined;
  if (code === 'inUse') {
    const users = [data?.libraries, data?.works].filter((value) => typeof value === 'string' && value.length > 0).join(', ');
    return `Used by ${users}. Choose another profile there first.`;
  }
  if (code === 'nameTaken') return 'Another profile has this name.';
  if (code === 'notShipped') return 'Only shipped profiles can be reset.';
  return 'The profile could not be saved. Check its fields.';
}
