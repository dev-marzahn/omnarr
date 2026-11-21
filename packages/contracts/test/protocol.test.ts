import { describe, expect, test } from 'vite-plus/test';

import { ActiveDownload, DownloadReport } from '../src/protocol.ts';

const status = { stage: 'stoppedUP', progress: 1, raw: { state: 'stoppedUP' } };

describe('the download reconciler’s exchange for torrents', () => {
  test('a completed report says whether the torrent is private', () => {
    const report = [{ downloadId: 'd1', outcome: 'completed', clientStatus: status, contentPath: '/data/downloads/torrents/platform-series/x', private: true }];
    expect(DownloadReport.parse(report)).toEqual(report);
  });

  test('seedingDone carries the final ratio and seed time; seedingLost carries neither', () => {
    const done = [{ downloadId: 'd1', outcome: 'seedingDone', clientStatus: status, seedRatio: 3.1, seedTimeMs: 1_209_600_000 }];
    expect(DownloadReport.parse(done)).toEqual(done);
    const lost = [{ downloadId: 'd1', outcome: 'seedingLost', clientStatus: { ...status, stage: 'missingFiles' } }];
    expect(DownloadReport.parse(lost)).toEqual(lost);
  });

  test('a watched Download says whether it is active or completed, with its goal', () => {
    const watched = {
      downloadId: 'd1',
      clientKind: 'qbittorrent',
      clientRef: 'ab'.repeat(20),
      correlationTag: 'g1',
      clientStage: 'downloading',
      state: 'completed',
      seedGoal: { ratio: 2 },
    };
    expect(ActiveDownload.parse(watched)).toEqual(watched);
    expect(() => ActiveDownload.parse({ ...watched, state: 'removed' })).toThrow();
  });
});
