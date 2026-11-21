// Human-readable labels for catalogue IDs on the settings pages: one place,
// so a quality or tier reads the same everywhere.
import type { QualityId } from '@omnarr/contracts';

const QUALITY_LABELS: Record<QualityId, string> = {
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
  brdisk: 'BR-DISK',
  rawhd: 'Raw-HD',
  workprint: 'Workprint',
  telecine: 'Telecine',
  telesync: 'Telesync',
  screener: 'Screener',
  cam: 'CAM',
  unknown: 'Unknown',
};

export const qualityLabel = (id: QualityId): string => QUALITY_LABELS[id];

/** The shipped tier formats, whose group lists are transcribed from TRaSH Guides. */
const GROUP_TIER_LABELS: Record<string, string> = {
  'group.tier1': 'Release group tier 1',
  'group.tier2': 'Release group tier 2',
  'group.tier3': 'Release group tier 3',
  'group.lowQuality': 'Low-quality groups',
  'anime.tier1': 'Anime release group tier 1',
  'anime.tier2': 'Anime release group tier 2',
  'anime.tier3': 'Anime release group tier 3',
};

/** "Release group tier 1 · TRaSH list"; another format keeps its ID. */
export const groupTierLabel = (formatId: string): string => {
  const label = GROUP_TIER_LABELS[formatId];
  return label === undefined ? formatId : `${label} · TRaSH list`;
};
