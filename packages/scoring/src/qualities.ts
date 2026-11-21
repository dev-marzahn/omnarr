// The quality catalogue: fixed entries, not user data.
import type { ParsedRelease, QualityId } from '@omnarr/contracts';

const NAMES: Record<QualityId, string> = {
  'remux-2160p': 'Remux 2160p',
  'bluray-2160p': 'Bluray 2160p',
  'webdl-2160p': 'WEB-DL 2160p',
  'webrip-2160p': 'WEBRip 2160p',
  'hdtv-2160p': 'HDTV 2160p',
  'remux-1080p': 'Remux 1080p',
  'bluray-1080p': 'Bluray 1080p',
  'webdl-1080p': 'WEB-DL 1080p',
  'webrip-1080p': 'WEBRip 1080p',
  'hdtv-1080p': 'HDTV 1080p',
  'bluray-720p': 'Bluray 720p',
  'webdl-720p': 'WEB-DL 720p',
  'webrip-720p': 'WEBRip 720p',
  'hdtv-720p': 'HDTV 720p',
  'bluray-576p': 'Bluray 576p',
  'bluray-480p': 'Bluray 480p',
  'webdl-480p': 'WEB-DL 480p',
  'webrip-480p': 'WEBRip 480p',
  dvd: 'DVD',
  sdtv: 'SDTV',
  brdisk: 'Bluray disc',
  rawhd: 'Raw HD',
  workprint: 'Workprint',
  telecine: 'Telecine',
  telesync: 'Telesync',
  screener: 'Screener',
  cam: 'CAM',
  unknown: 'Unknown',
};

/** The catalogue in QualityId's order, best first: the order disallowed qualities rank in. */
export const QUALITIES: readonly { id: QualityId; name: string }[] = Object.entries(NAMES).map(([id, name]) => ({ id: id as QualityId, name }));

type Column = '2160' | '1080' | '720' | '576' | 'sd';

function columnOf(resolution: ParsedRelease['resolution']): Column | undefined {
  if (resolution === undefined) return undefined;
  if (resolution >= 2160) return '2160';
  if (resolution >= 1080) return '1080';
  if (resolution >= 720) return '720';
  if (resolution >= 576) return '576';
  return 'sd';
}

/** A row of the quality table: the quality per resolution column, and the assumed one with no resolution. */
type Row = { byColumn: Record<Column, QualityId>; none: QualityId; noneAssumed: boolean };

const row = (prefix: 'bluray' | 'webdl' | 'webrip', sd: QualityId, s576: QualityId): Row => ({
  byColumn: { '2160': `${prefix}-2160p`, '1080': `${prefix}-1080p`, '720': `${prefix}-720p`, '576': s576, sd },
  none: `${prefix}-1080p`,
  noneAssumed: true,
});

const ROWS = {
  remux: {
    byColumn: { '2160': 'remux-2160p', '1080': 'remux-1080p', '720': 'remux-1080p', '576': 'remux-1080p', sd: 'remux-1080p' },
    none: 'remux-1080p',
    noneAssumed: false,
  },
  bluray: row('bluray', 'bluray-480p', 'bluray-576p'),
  webdl: row('webdl', 'webdl-480p', 'webdl-480p'),
  webrip: row('webrip', 'webrip-480p', 'webrip-480p'),
  hdtv: { byColumn: { '2160': 'hdtv-2160p', '1080': 'hdtv-1080p', '720': 'hdtv-720p', '576': 'sdtv', sd: 'sdtv' }, none: 'hdtv-720p', noneAssumed: true },
  resolutionOnly: {
    byColumn: { '2160': 'webdl-2160p', '1080': 'webdl-1080p', '720': 'webdl-720p', '576': 'webdl-480p', sd: 'webdl-480p' },
    none: 'unknown',
    noneAssumed: false,
  },
} satisfies Record<string, Row>;

/** The same quality at any resolution. */
const FIXED = new Set(['sdtv', 'dvd', 'cam', 'telesync', 'telecine', 'screener', 'workprint']);

function rowOf(parsed: ParsedRelease): Row | QualityId {
  if (parsed.modifier === 'brdisk' || parsed.modifier === 'rawhd') return parsed.modifier;
  // The remux row is "bluray (remux)"; a DVD remux keeps DVD quality.
  if (parsed.modifier === 'remux' && (parsed.source === undefined || parsed.source === 'bluray')) return ROWS.remux;
  const source = parsed.source;
  if (source === undefined) return ROWS.resolutionOnly;
  if (FIXED.has(source)) return source as QualityId;
  if (source === 'hdtv' || source === 'ppv') return ROWS.hdtv;
  return ROWS[source as 'bluray' | 'webdl' | 'webrip'];
}

/** The quality a parsed release names. `assumed` when the resolution had to be assumed. */
export function qualityOf(parsed: ParsedRelease): { quality: QualityId; assumed: boolean } {
  const found = rowOf(parsed);
  if (typeof found === 'string') return { quality: found, assumed: false };
  const column = columnOf(parsed.resolution);
  return column === undefined ? { quality: found.none, assumed: found.noneAssumed } : { quality: found.byColumn[column], assumed: false };
}
