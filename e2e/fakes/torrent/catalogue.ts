// The torrents the `torrents` e2e scenario downloads: the
// Torznab fake lists them (NEWZNAB_CATALOGUE=torrents), the web-seed fake
// serves their content and seeds the magnets. Every torrent is the same
// sample file under its release's name (../usenet/media/README.md), so each
// one imports and plays, and each name gives its own info hash.
//
//   S01E01  a .torrent link, downloaded from the web seed: import, a
//           one-minute seeding goal, then the torrent and its folder go;
//   S01E02  only a magnet: the metadata and pieces come from the seed peer;
//   S01E03  the best release's web seed never answers, so it stalls, is
//           blocklisted, and next-best takes the second one;
//   S01E04  a web seed that trickles, so the download is still incomplete
//           when the scenario cancels it.
import { readMedia } from '../usenet/catalogue.ts';
import { makeTorrent, type Torrent } from './torrent.ts';

export type TorrentEntry = {
  guid: string;
  title: string;
  /** The file in the torrent, and on the web seed. */
  fileName: string;
  /** Torrents rank by seeders: the stalled S01E03 outranks its fallback. */
  seeders: number;
  /** Listed with only its magnet, which names the seed peer. */
  magnet?: true;
  mode?: 'stall' | { bytesPerSecond: number };
  content: Uint8Array;
  torrent: Torrent;
};

/** Where the clients reach the web seed on the test network (compose.test.yml). */
export const WEBSEED_URL = 'http://webseed:4130/files/';
/** The web seed's tracker: its announces make qBittorrent apply a seeding limit (../webseed/server.ts). */
export const TRACKER_URL = 'http://webseed:4130/announce';

const entries: Omit<TorrentEntry, 'content' | 'torrent' | 'fileName'>[] = [
  { guid: 'hl-t-s01e01', title: 'Harbour.Lights.S01E01.1080p.WEB-DL.AAC2.0.H.264-GRPB', seeders: 20 },
  { guid: 'hl-t-s01e02', title: 'Harbour.Lights.S01E02.1080p.WEB-DL.AAC2.0.H.264-GRPB', seeders: 20, magnet: true },
  { guid: 'hl-t-s01e03-stall', title: 'Harbour.Lights.S01E03.1080p.WEB-DL.AAC2.0.H.264-GRPB', seeders: 50, mode: 'stall' },
  { guid: 'hl-t-s01e03', title: 'Harbour.Lights.S01E03.1080p.WEB-DL.AAC2.0.H.264-GRPF', seeders: 10 },
  { guid: 'hl-t-s01e04-slow', title: 'Harbour.Lights.S01E04.1080p.WEB-DL.AAC2.0.H.264-GRPB', seeders: 20, mode: { bytesPerSecond: 64 } },
];

export function torrentCatalogue(media: Uint8Array = readMedia(), webseedHost = 'webseed:4130'): TorrentEntry[] {
  return entries.map((entry) => {
    const fileName = `${entry.title}.mkv`;
    return {
      ...entry,
      fileName,
      content: media,
      torrent: makeTorrent({ name: fileName, content: media, webSeeds: [`http://${webseedHost}/files/`], announce: `http://${webseedHost}/announce` }),
    };
  });
}

/**
 * The `nyaa` scenario's torrents: Star Lantern episodes as Nyaa
 * lists them, magnets only, so the seed peer serves them. Episode 1 is on
 * the fake Nyaa from the start (the season search grabs it); episode 3 is
 * published later, for RSS. The titles are their file names.
 */
const nyaaEntries: Omit<TorrentEntry, 'content' | 'torrent' | 'fileName'>[] = [
  { guid: 'sl-n-01', title: '[SubsPlease] Star Lantern - 01 (1080p) [5E1A0001].mkv', seeders: 30, magnet: true },
  { guid: 'sl-n-03', title: '[SubsPlease] Star Lantern - 03 (1080p) [5E1A0003].mkv', seeders: 30, magnet: true },
];

export function nyaaCatalogue(media: Uint8Array = readMedia(), webseedHost = 'webseed:4130'): TorrentEntry[] {
  return nyaaEntries.map((entry) => ({
    ...entry,
    fileName: entry.title,
    content: media,
    torrent: makeTorrent({ name: entry.title, content: media, webSeeds: [`http://${webseedHost}/files/`], announce: `http://${webseedHost}/announce` }),
  }));
}

/**
 * The `vpn` scenario's torrents: S01E01 downloads through the
 * tunnel, the trickling S01E04 is in progress when the WireGuard server stops.
 * Their web seed and tracker are the web seed's address behind the test
 * WireGuard server, an IP, since nothing in gluetun's network resolves its
 * name. Both sit outside the info dict, so the info hashes are the
 * `torrents` scenario's.
 */
export function vpnCatalogue(webseedHost: string, media: Uint8Array = readMedia()): TorrentEntry[] {
  return torrentCatalogue(media, webseedHost).filter((entry) => entry.guid === 'hl-t-s01e01' || entry.guid === 'hl-t-s01e04-slow');
}
