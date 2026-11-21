import { describe, expect, test } from 'vite-plus/test';

import { DownloadSource, JobPayload, JobResult, PreparePayload, PrepareResult } from '../src/jobs.ts';
import type { NamingContext } from '../src/naming.ts';
import type { ProbeSummary, TargetFormat } from '../src/playback.ts';

/** A series Work and release, as `works.folder` and the Grab's candidate give them. */
const naming: NamingContext = {
  kind: 'series',
  title: 'Show',
  year: 2019,
  tmdbId: 123,
  anime: false,
  release: {
    title: 'Show.S01E02.1080p.AMZN.WEB-DL.DDP5.1.H.264-GRP',
    normalizedTitle: 'show',
    episodes: [{ season: 1, episode: 2 }],
    special: false,
    extras: false,
    resolution: 1080,
    source: 'webdl',
    streamingService: 'AMZN',
    videoCodec: 'h264',
    hdr: [],
    audioCodec: 'eac3',
    audioChannels: '5.1',
    atmos: false,
    languages: [],
    subtitleLanguages: [],
    hardcodedSubs: false,
    edition: {},
    revision: { version: 1, real: 0, repack: false },
    group: 'GRP',
    container: 'mkv',
    notes: [],
    quality: 'webdl-1080p',
  },
};

const workFolderPath = '/data/library/series/Show (2019) [tmdbid-123]';

describe('import', () => {
  const payload = {
    class: 'import',
    grabId: 'g1',
    importJobId: 'i1',
    contentPath: '/data/downloads/usenet/complete/Show.S01E02',
    workFolderPath,
    expectedUnits: [{ unitId: 'u1', season: 1, episode: 2, title: 'Pilot' }],
    naming,
  };

  test("names the Work folder, the Units' titles and the naming context", () => {
    expect(JobPayload.parse(payload)).toEqual(payload);
  });

  test("a movie's expected Unit has no numbers and may have no title", () => {
    const movie = { ...payload, expectedUnits: [{ unitId: 'u1' }], naming: { ...naming, kind: 'movie' } };
    expect(JobPayload.parse(movie)).toEqual(movie);
  });

  test('the old payload, with libraryPath and without the Work folder or naming, is rejected', () => {
    const { workFolderPath: _folder, naming: _naming, ...m3 } = payload;
    expect(() => JobPayload.parse({ ...m3, libraryPath: '/data/library/series' })).toThrow();
    expect(() => JobPayload.parse({ ...payload, naming: undefined })).toThrow();
  });
});

describe('prepare', () => {
  const target: TargetFormat = {
    containers: ['mp4'],
    video: { codecs: ['h264'], maxHeight: 1080, maxBitrateKbps: null, hdr: 'sdrOnly', maxBitDepth: { h264: 8, hevc: 8, av1: 8 } },
    audio: { codecs: ['aac', 'mp3', 'opus', 'flac'], maxChannels: 2 },
    subtitles: { mode: 'text', textFormats: ['srt', 'ass'] },
  };
  const payload = {
    class: 'prepare',
    renditionId: 'r1',
    sourceFileId: 'f1',
    sourcePath: `${workFolderPath}/Season 01/Show (2019) - S01E02 - Pilot [AMZN][WEBDL-1080p][EAC3 5.1][h264]-GRP.mkv`,
    sourceInode: '64768:1234',
    targetProfileId: 'pp1',
    target,
    disposition: 'replace',
    naming,
    units: [{ season: 1, episode: 2, title: 'Pilot' }],
    outputFolder: `${workFolderPath}/Season 01`,
    originalsFolder: '/data/originals/series/Show (2019) [tmdbid-123]/Season 01',
  };

  test('names the source, the target, the disposition and the naming context', () => {
    expect(JobPayload.parse(payload)).toEqual(payload);
    expect(PreparePayload.parse(payload)).toEqual(payload);
  });

  test('a file that keeps its name passes only its base name', () => {
    const keeping = { ...payload, disposition: 'keep', naming: { keepBaseName: 'My Own Name' } };
    expect(JobPayload.parse(keeping)).toEqual(keeping);
  });

  test("a kept original's job names the Unit's current primary it replaces", () => {
    const fromOriginal = {
      ...payload,
      sourcePath: '/data/originals/series/Show (2019) [tmdbid-123]/Season 01/source.mkv',
      replacesPath: `${workFolderPath}/Season 01/Show (2019) - S01E02 - Pilot [AMZN][WEBDL-1080p][AAC 2.0][h264]-GRP.mp4`,
    };
    expect(JobPayload.parse(fromOriginal)).toEqual(fromOriginal);
    expect(() => JobPayload.parse({ ...payload, replacesPath: 42 })).toThrow();
  });

  test('an unknown disposition is rejected', () => {
    expect(() => JobPayload.parse({ ...payload, disposition: 'move' })).toThrow();
  });

  const output: ProbeSummary = {
    container: 'mp4',
    durationMs: 2_640_000,
    streams: [
      {
        index: 0,
        kind: 'video',
        codec: 'h264',
        width: 1920,
        height: 1080,
        bitDepth: 8,
        pixFmt: 'yuv420p',
        interlaced: false,
        hdr: 'sdr',
        default: true,
        forced: false,
        hearingImpaired: false,
      },
      { index: 1, kind: 'audio', codec: 'aac', channels: 2, language: 'en', default: true, forced: false, hearingImpaired: false },
    ],
  };
  const done = {
    class: 'prepare',
    noChange: false,
    outputPath: `${workFolderPath}/Season 01/Show (2019) - S01E02 - Pilot [AMZN][WEBDL-1080p][AAC 2.0][h264]-GRP.mp4`,
    sizeBytes: 1_200_000_000,
    inode: '64768:5678',
    probe: output,
    encoder: 'copy',
    steps: ['audio', 'subtitle', 'remux'],
    sidecars: [
      {
        path: `${workFolderPath}/Season 01/Show (2019) - S01E02 - Pilot [AMZN][WEBDL-1080p][AAC 2.0][h264]-GRP.en.srt`,
        language: 'en',
        forced: false,
        sdh: false,
        format: 'srt',
      },
      {
        path: `${workFolderPath}/Season 01/Show (2019) - S01E02 - Pilot [AMZN][WEBDL-1080p][AAC 2.0][h264]-GRP.de.srt`,
        language: 'de',
        forced: false,
        sdh: false,
        format: 'srt',
      },
    ],
    droppedTracks: [],
    sourceRemoved: true,
  };

  test('the full result records the output, its probe, sidecars and what happened to the source', () => {
    expect(JobResult.parse(done)).toEqual(done);
    expect(PrepareResult.parse(done)).toEqual(done);
  });

  test("with keep, the result names the original's new path and sidecars", () => {
    const kept = { ...done, originalPath: '/data/originals/series/Show (2019) [tmdbid-123]/Season 01/source.mkv', originalSidecars: [] };
    expect(JobResult.parse(kept)).toEqual(kept);
  });

  test('a kept original that fits is restored: the output is the original, moved back', () => {
    const restored = { ...done, restored: true, encoder: 'copy', steps: [] };
    expect(JobResult.parse(restored)).toEqual(restored);
    expect(() => JobResult.parse({ ...done, restored: false })).toThrow();
  });

  test('a source that already fit completes with noChange', () => {
    expect(JobResult.parse({ class: 'prepare', noChange: true })).toEqual({ class: 'prepare', noChange: true });
  });

  test('a full result needs its output path and probe', () => {
    const { outputPath: _path, ...withoutPath } = done;
    expect(() => JobResult.parse(withoutPath)).toThrow();
    expect(() => JobResult.parse({ ...done, probe: undefined })).toThrow();
  });
});

describe('renameLibraryFile', () => {
  test('renames a file and its sidecars, and reports the new path', () => {
    const payload = {
      class: 'maintenance',
      action: 'renameLibraryFile',
      fileId: 'f1',
      from: `${workFolderPath}/Season 01/Show (2019) - S01E02 - Episode 2 [WEBDL-1080p].mp4`,
      to: `${workFolderPath}/Season 01/Show (2019) - S01E02 - Pilot [WEBDL-1080p].mp4`,
      sidecars: [
        {
          from: `${workFolderPath}/Season 01/Show (2019) - S01E02 - Episode 2 [WEBDL-1080p].en.srt`,
          to: `${workFolderPath}/Season 01/Show (2019) - S01E02 - Pilot [WEBDL-1080p].en.srt`,
        },
      ],
    };
    expect(JobPayload.parse(payload)).toEqual(payload);
    const result = { class: 'maintenance', action: 'renameLibraryFile', path: payload.to };
    expect(JobResult.parse(result)).toEqual(result);
  });

  test('a rename without its sidecar list is rejected', () => {
    expect(() => JobPayload.parse({ class: 'maintenance', action: 'renameLibraryFile', fileId: 'f1', from: '/a.mp4', to: '/b.mp4' })).toThrow();
  });
});

describe('scanLibrary', () => {
  test('walks the roots, skipping the ignored folders, and reports what it found', () => {
    const payload = {
      class: 'maintenance',
      action: 'scanLibrary',
      scanRunId: 'r1',
      roots: [
        { libraryId: 'l1', path: '/data/library/series' },
        { libraryId: 'l2', path: '/data/library/movies' },
      ],
      ignores: ['/data/library/series/Home Videos'],
    };
    expect(JobPayload.parse(payload)).toEqual(payload);
    const result = { class: 'maintenance', action: 'scanLibrary', found: 1204, untracked: 69 };
    expect(JobResult.parse(result)).toEqual(result);
  });

  test('a scan without its roots is rejected', () => {
    expect(() => JobPayload.parse({ class: 'maintenance', action: 'scanLibrary', scanRunId: 'r1', ignores: [] })).toThrow();
  });
});

describe('maintenance payloads', () => {
  test('removeDownload names the client, and the download row when there is one', () => {
    const payload = { class: 'maintenance', action: 'removeDownload', downloadId: 'd1', clientKind: 'nzbget', clientRef: '42', deleteData: true };
    expect(JobPayload.parse(payload)).toEqual(payload);
  });

  test('removeDownload for an orphan client item has no download row', () => {
    const payload = { class: 'maintenance', action: 'removeDownload', clientKind: 'qbittorrent', clientRef: 'abcdef', deleteData: true };
    expect(JobPayload.parse(payload)).toEqual(payload);
  });

  test('removeDownload without a client kind is rejected', () => {
    expect(() => JobPayload.parse({ class: 'maintenance', action: 'removeDownload', clientRef: '42', deleteData: true })).toThrow();
  });

  test('deleteLibraryFiles takes the paths to delete, and the library and folders the playback target forgets, and reports the ones removed', () => {
    const payload = {
      class: 'maintenance',
      action: 'deleteLibraryFiles',
      paths: ['/data/library/series/A/S01E01.mp4'],
      libraryId: 'l1',
      folders: ['/data/library/series/A'],
    };
    expect(JobPayload.parse(payload)).toEqual(payload);
    const result = { class: 'maintenance', action: 'deleteLibraryFiles', removedPaths: ['/data/library/series/A/S01E01.mp4'] };
    expect(JobResult.parse(result)).toEqual(result);
  });

  test('deleteLibraryFiles without the library is rejected', () => {
    expect(() => JobPayload.parse({ class: 'maintenance', action: 'deleteLibraryFiles', paths: [], folders: [] })).toThrow();
  });
});

describe('publish', () => {
  const payload = {
    class: 'publish',
    publicationIds: ['p1'],
    workFolderPath: '/data/library/series/Harbour Lights (2021) [tmdbid-1001]',
    items: [{ publicationId: 'p1', path: '/data/library/series/Harbour Lights (2021) [tmdbid-1001]/Season 01/E1.mkv' }],
    library: { libraryId: 'l1', root: '/data/library/series', kind: 'series' },
  };

  test('names the Work folder and the library', () => {
    expect(JobPayload.parse(payload)).toEqual(payload);
  });

  test('a payload without the library is rejected', () => {
    const { library: _, ...rest } = payload;
    expect(() => JobPayload.parse(rest)).toThrow();
  });
});

describe('the download job contracts', () => {
  const submit = {
    class: 'download.submit',
    grabId: 'g1',
    downloadId: 'd1',
    source: { kind: 'nzbUrl', url: 'http://indexer.invalid/getnzb/1.nzb' },
    correlationTag: 'g1',
    category: 'platform-series',
  };

  test('download.submit names the indexer the release comes from', () => {
    expect(JobPayload.parse({ ...submit, indexerName: 'Main' })).toMatchObject({ indexerName: 'Main' });
    expect(() => JobPayload.parse(submit)).toThrow();
  });

  test('a torrent download.submit carries its seeding goal, which needs a limit', () => {
    const torrent = { ...submit, indexerName: 'Tracker', source: { kind: 'magnet', uri: 'magnet:?xt=urn:btih:00' } };
    expect(JobPayload.parse({ ...torrent, seedGoal: { seedTimeMs: 60_000 } })).toMatchObject({ seedGoal: { seedTimeMs: 60_000 } });
    expect(() => JobPayload.parse({ ...torrent, seedGoal: {} })).toThrow();
  });

  test('testUsenetServer carries the provider login, and its result is one of three outcomes', () => {
    const payload = { class: 'maintenance', action: 'testUsenetServer', host: 'news.example', port: 563, ssl: true, username: 'u', password: 'p' };
    expect(JobPayload.parse(payload)).toEqual(payload);
    for (const outcome of ['ok', 'authRejected', 'failed'])
      expect(JobResult.parse({ class: 'maintenance', action: 'testUsenetServer', outcome })).toMatchObject({ outcome });
    expect(() => JobResult.parse({ class: 'maintenance', action: 'testUsenetServer', outcome: 'maybe' })).toThrow();
  });

  test('removeDownload takes the Grab tag a shared torrent loses', () => {
    const payload = { class: 'maintenance', action: 'removeDownload', clientKind: 'qbittorrent', clientRef: 'ab', deleteData: true, correlationTag: 'g1' };
    expect(JobPayload.parse(payload)).toEqual(payload);
  });

  test('the indexer class carries search, rss and test, with no secret', () => {
    const request = { fn: 'search', q: 'Star Lantern', categories: [5070], limit: 100, offset: 0 };
    for (const payload of [
      { class: 'indexer', action: 'search', indexerId: 'i1', request },
      { class: 'indexer', action: 'rss', indexerId: 'i1' },
      { class: 'indexer', action: 'test', indexerId: 'i1' },
    ])
      expect(JobPayload.parse(payload)).toEqual(payload);
    expect(() => JobPayload.parse({ class: 'indexer', action: 'search', indexerId: 'i1', request, settings: { password: 'x' } })).toThrow();
    const page = { class: 'indexer', outcome: { ok: true, value: { items: [], offset: 0 } } };
    expect(JobResult.parse(page)).toEqual(page);
    const skipped = { class: 'indexer', outcome: { ok: false, skipped: 'paced' } };
    expect(JobResult.parse(skipped)).toEqual(skipped);
    const failed = { class: 'indexer', outcome: { ok: false, failure: { kind: 'unexpectedPage', code: 'indexerError', host: 'site.test', path: '/' } } };
    expect(JobResult.parse(failed)).toEqual(failed);
  });

  test('syncDefinitions is a maintenance action, and a site URL a download source', () => {
    expect(JobPayload.parse({ class: 'maintenance', action: 'syncDefinitions' })).toEqual({ class: 'maintenance', action: 'syncDefinitions' });
    const result = { class: 'maintenance', action: 'syncDefinitions', ok: true, supported: 3, unsupported: 2, pending: 0 };
    expect(JobResult.parse(result)).toEqual(result);
    expect(DownloadSource.parse({ kind: 'siteUrl', url: 'https://site.test/t/1', indexerId: 'i1' })).toEqual({
      kind: 'siteUrl',
      url: 'https://site.test/t/1',
      indexerId: 'i1',
    });
  });

  test('applyClientConfig is gone: the reconciler applies client config', () => {
    expect(() => JobPayload.parse({ class: 'maintenance', action: 'applyClientConfig', clientId: 'c1' })).toThrow();
    expect(() => JobResult.parse({ class: 'maintenance', action: 'applyClientConfig', applied: true })).toThrow();
  });
});
