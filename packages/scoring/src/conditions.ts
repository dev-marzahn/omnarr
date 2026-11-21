// User-format rules: conditions on parser fields only.
import type { Condition, EditionFlag, FormatRule, ParsedRelease } from '@omnarr/contracts';

/** A PROPER, REPACK or anime v2 or later (the `repack` condition and built-in format). */
export const isRepack = (release: ParsedRelease): boolean => release.revision.repack || release.revision.version > 1;

function matches(condition: Condition, release: ParsedRelease): boolean {
  switch (condition.field) {
    case 'resolution':
    case 'bitDepth': {
      const value = release[condition.field];
      if (condition.op === 'notIn') return value === undefined || !condition.values.includes(value);
      if (value === undefined) return false;
      if (condition.op === 'in') return condition.values.includes(value);
      return condition.values.every((limit) => (condition.op === 'gte' ? value >= limit : value <= limit));
    }
    case 'hdr':
    case 'languages':
    case 'subtitleLanguages': {
      const have = new Set<string>(release[condition.field]);
      if (condition.op === 'any') return condition.values.some((value) => have.has(value));
      if (condition.op === 'all') return condition.values.every((value) => have.has(value));
      return !condition.values.some((value) => have.has(value));
    }
    case 'atmos':
    case 'hardcodedSubs':
      return release[condition.field] === condition.value;
    case 'repack':
      return isRepack(release) === condition.value;
    case 'source':
    case 'videoCodec':
    case 'audioCodec':
    case 'audioChannels':
    case 'streamingService':
    case 'group':
    case 'modifier':
    case 'container': {
      const fold = (text: string) => (condition.field === 'group' ? text.toLowerCase() : text);
      const value = release[condition.field];
      const listed = value !== undefined && condition.values.some((entry) => fold(entry) === fold(value));
      return condition.op === 'in' ? listed : !listed;
    }
    default: {
      const flag = condition.field.slice('edition.'.length) as EditionFlag;
      return (release.edition[flag] === true) === condition.value;
    }
  }
}

/** All of `all`, at least one of `any` (when it lists any), none of `none`. */
export function evaluateRule(rule: FormatRule, release: ParsedRelease): boolean {
  const all = rule.all ?? [];
  const any = rule.any ?? [];
  const none = rule.none ?? [];
  return all.every((c) => matches(c, release)) && (any.length === 0 || any.some((c) => matches(c, release))) && !none.some((c) => matches(c, release));
}
