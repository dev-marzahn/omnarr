// The Newznab fake's default catalogue. Made-up titles and IDs, matching the
// TMDB fake's shows where they share a name.
import type { Release } from '../usenet/release.ts';

export type FakeItem = {
  guid: string;
  title: string;
  categories: number[];
  sizeBytes: number;
  /** ISO 8601. */
  publishedAt: string;
  ids?: { tvdbid?: string; tmdbid?: string; imdbid?: string };
  /** The release whose NZB `/getnzb/<guid>.nzb` serves; without one it answers 404. */
  release?: Release;
  /** Torznab mode only: the item's torrent. */
  torrent?: FakeTorrent;
  /** Listed under every search in its categories, whatever `q`, the IDs and the numbers say: an indexer that ignores the numbers. */
  everyQuery?: boolean;
};

export type FakeTorrent = {
  /** 40 lowercase hex characters. */
  infoHash: string;
  seeders: number;
  peers?: number;
  minimumRatio?: number;
  minimumSeedTimeSec?: number;
  /** The file `/dl/<guid>.torrent` serves. Without one the item links only its magnet. */
  file?: Uint8Array<ArrayBuffer>;
  /** Appended to the magnet, already encoded: `x.pe=…`, `ws=…`. */
  magnetParams?: string;
};

/**
 * The e2e catalogue's releases (../usenet/catalogue.ts) as Harbour Lights HD
 * episodes, each a day newer than the one before it in the catalogue.
 */
export const e2eItems = (releases: Release[]): FakeItem[] =>
  releases.map((release, index) => ({
    guid: release.entry.guid,
    title: release.entry.title,
    categories: [5000, 5040],
    sizeBytes: release.content.length,
    publishedAt: new Date(Date.parse('2026-11-10T20:00:00Z') + index * 86_400_000).toISOString(),
    ids: { tvdbid: '7700001' },
    release,
    ...(release.entry.everyQuery ? { everyQuery: true } : {}),
  }));

export const ITEMS: FakeItem[] = [
  {
    guid: '9c0d1e2f',
    title: 'The.Long.Harbor.S01.1080p.WEB-DL.DDP5.1.H.264-GRPA',
    categories: [5000, 5040],
    sizeBytes: 9_000_000_000,
    publishedAt: '2026-11-14T20:00:00Z',
    ids: { tvdbid: '7700001' },
  },
  {
    guid: '3d4e5f60',
    title: '[SubGroup] Lantern Keeper - 12 (1080p) [0A1B2C3D].mkv',
    categories: [5070],
    sizeBytes: 1_400_000_000,
    publishedAt: '2026-11-12T16:30:00Z',
  },
  {
    guid: '5e6f7a8b',
    title: 'Quiet.Orchard.2024.1080p.WEB-DL.DDP5.1.H.264-GRPB',
    categories: [2000, 2040],
    sizeBytes: 6_000_000_000,
    publishedAt: '2026-11-11T07:05:00Z',
    ids: { imdbid: 'tt9900101', tmdbid: '900101' },
  },
  {
    guid: '0a1b2c3d',
    title: 'The.Long.Harbor.S01E02.1080p.WEB-DL.DDP5.1.H.264-GRPA',
    categories: [5000, 5040],
    sizeBytes: 1_500_000_000,
    publishedAt: '2026-11-10T18:30:00Z',
    ids: { tvdbid: '7700001' },
  },
  {
    guid: '7f8e9d0c',
    title: 'The.Long.Harbor.S01E01.720p.HDTV.x264-GRPC',
    categories: [5000, 5030],
    sizeBytes: 900_000_000,
    publishedAt: '2026-11-03T21:00:00Z',
    ids: { tvdbid: '7700001' },
  },
  {
    guid: '1b2a3c4d',
    title: 'Paper Lantern Road 2019 720p BluRay x264-GRPC',
    categories: [2000, 2040],
    sizeBytes: 4_400_000_000,
    publishedAt: '2026-11-01T12:00:00Z',
  },
];
