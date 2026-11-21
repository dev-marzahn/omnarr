// Group fix after the library mapping. The library sometimes takes the second
// half of a hyphenated tag for the group (`E-AC-3` → `AC`, `U-NEXT` → `NEXT`,
// `VC-1` → `1`); the release's own `-Group` at the end then wins.
import type { ParsedRelease } from '@omnarr/contracts';

/** A re-tagger's suffix after the group: `REMUX-Group.DUAL-Tagger`, `.Dual-Tagger`. */
const RETAG = /\.(?:DUAL|Dual)-[A-Za-z0-9]+$/;
const TRAILING = /-([A-Za-z0-9]+)$/;
/** Halves of hyphenated tags, never a group at the end of a title. */
const NOT_A_GROUP = new Set(['DL', 'HD', 'RIP', 'X', 'MA', 'RAY']);
const NO_GROUP = /^no-?gr(ou)?p$/i;

function withGroup(partial: ParsedRelease, name: string | undefined): ParsedRelease {
  const { group: _dropped, ...rest } = partial;
  return name === undefined || NO_GROUP.test(name) ? rest : { ...rest, group: name };
}

export function group(cleanTitle: string, partial: ParsedRelease): ParsedRelease {
  const current = partial.group;
  if (current === undefined) return partial;
  if (NO_GROUP.test(current)) return withGroup(partial, undefined);
  const at = cleanTitle.lastIndexOf(`-${current}`);
  // The group is the last hyphenated name, or only a site suffix follows it.
  if (at < 0 || !cleanTitle.slice(at + current.length + 1).includes('-')) return partial;
  const trailing = TRAILING.exec(cleanTitle.replace(RETAG, ''))?.[1];
  if (trailing === undefined || trailing === current || NOT_A_GROUP.has(trailing.toUpperCase())) return partial;
  return withGroup(partial, trailing);
}
