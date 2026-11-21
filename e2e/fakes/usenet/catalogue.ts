// The releases the e2e scenarios download: the
// Newznab fake lists them (NEWZNAB_CATALOGUE=e2e) and the NNTP fake serves
// their articles. Each release's content is one of the files in media/
// (media/README.md), so each one imports and plays. Made-up titles, matching
// the TMDB fake's shows.
import { readFileSync } from 'node:fs';

import { createRelease, DEFAULT_PART_SIZE, type Release, type ReleaseEntry } from './release.ts';

export type { Release, ReleaseEntry } from './release.ts';

/** Small enough that the ~19 KB sample splits into five parts, so damage leaves gaps. */
export const E2E_PART_SIZE = 4096;

/** A release of the catalogue: its entry, the file under media/ it serves, and its article size. */
export type CatalogueEntry = ReleaseEntry & { media: string; partSize: number };

/**
 * The file the S02E01 release serves: a minute of 1080p HEVC Main 10 with
 * E-AC-3 5.1, too big to commit (about 10 MB). `e2e/stack.ts` makes it with
 * these ffmpeg arguments in a container of the worker image before the
 * stack comes up, and keeps it for later runs.
 */
export const GENERATED_MEDIA = {
  file: 'generated/hevc-1min.mkv',
  /** Its length, for the e2e's measurement. */
  durationS: 60,
  ffmpegArgs: [
    '-f lavfi -i testsrc2=size=1920x1080:rate=24:duration=60',
    '-f lavfi -i sine=frequency=440:sample_rate=48000:duration=60',
    '-c:v libx265 -preset ultrafast -b:v 1M -pix_fmt yuv420p10le -x265-params log-level=error',
    '-c:a eac3 -b:a 384k -ac 6 -metadata:s:a:0 language=eng -disposition:v:0 default -disposition:a:0 default',
  ].flatMap((group) => group.split(' ')),
} as const;

const entry = (guid: string, title: string, media: string, partSize: number, damaged?: boolean, everyQuery?: boolean): CatalogueEntry => ({
  guid,
  title,
  fileName: `${title}.mkv`,
  media,
  partSize,
  ...(damaged ? { damaged } : {}),
  ...(everyQuery ? { everyQuery } : {}),
});

/**
 * Published a day apart in this order. The damaged S01E02 is the newest of
 * season 1, so it wins the tie with the good one (Usenet ties go to the newer
 * post) and the next-best search falls back to GRPF. The season 2 releases
 * name no video codec, so H.264 is predicted and they aren't ranked out (a
 * wrong guess costs ranking, not correctness); their files are HEVC.
 */
export const E2E_CATALOGUE: CatalogueEntry[] = [
  // H.264, E-AC-3 5.1, English and German SubRip in Matroska.
  entry('hl-s01e01', 'Harbour.Lights.S01E01.1080p.WEB-DL.DDP5.1.H.264-GRPB', 'webdl.mkv', 64 * 1024),
  entry('hl-s01e02', 'Harbour.Lights.S01E02.1080p.WEB-DL.AAC2.0.H.264-GRPF', 'sample.mkv', E2E_PART_SIZE),
  entry('hl-s01e02-bad', 'Harbour.Lights.S01E02.1080p.WEB-DL.AAC2.0.H.264-GRPB', 'sample.mkv', E2E_PART_SIZE, true),
  // A video transcode long enough to kill the worker during it.
  entry('hl-s02e01', 'Harbour.Lights.S02E01.1080p.WEB-DL.DDP5.1-GRPB', GENERATED_MEDIA.file, DEFAULT_PART_SIZE),
  // A video transcode whose output fails the duration check.
  entry('hl-s02e02', 'Harbour.Lights.S02E02.1080p.WEB-DL.DDP5.1-GRPB', 'cut-short.mkv', 64 * 1024),
  // An absolute number on a standard series, which the metadata can't settle, so no search grabs it; listed under
  // every query, so "Search and pick" for S01E03 offers it, and a manual grab imports it as S01E03. The newest.
  entry('hl-unclear-03', '[Kaze] Harbour Lights - 03 (1080p) [B1C2D3E4]', 'sample.mkv', E2E_PART_SIZE, false, true),
];

/** The file under media/ a release serves. */
export const mediaUrl = (media: string): URL => new URL(`./media/${media}`, import.meta.url);

export function readMedia(media = 'sample.mkv'): Uint8Array {
  try {
    return new Uint8Array(readFileSync(mediaUrl(media)));
  } catch (error) {
    if (media === GENERATED_MEDIA.file)
      throw new Error(`media/${media} is missing: e2e/stack.ts generates it before the stack comes up (media/README.md).`, { cause: error });
    throw error;
  }
}

/** The entries as releases of their files; each file is read once. */
export function loadCatalogue(entries: CatalogueEntry[] = E2E_CATALOGUE): Release[] {
  const files = new Map<string, Uint8Array>();
  return entries.map(({ media, partSize, ...item }) => {
    if (!files.has(media)) files.set(media, readMedia(media));
    return createRelease(item, files.get(media)!, { partSize });
  });
}

/** The releases whose files are committed: the fakes' own tests run without the generated one. */
export const COMMITTED_CATALOGUE: CatalogueEntry[] = E2E_CATALOGUE.filter((item) => item.media !== GENERATED_MEDIA.file);
