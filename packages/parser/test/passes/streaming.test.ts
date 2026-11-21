import { describe, expect, test } from 'vite-plus/test';

import { streaming } from '../../src/passes/streaming.ts';
import { STREAMING_SERVICES } from '../../src/tables/streamingServices.ts';
import { release } from './release.ts';

const run = (title: string, overrides = {}) => streaming(title, release({ group: 'GRPA', ...overrides }));

describe('streaming (pass 6)', () => {
  test.each(STREAMING_SERVICES.map((service) => [service]))('reads %s directly before WEB-DL', (service) => {
    expect(run(`The.Long.Harbor.S01E01.1080p.${service}.WEB-DL.DDP5.1.H.264-GRPA`).streamingService).toBe(service);
  });

  test.each(['WEB', 'WEB-DL', 'WEBDL', 'WEBRip', 'webrip'])('counts it before %s', (tag) => {
    expect(run(`The.Long.Harbor.S01E01.1080p.NF.${tag}.x264-GRPA`).streamingService).toBe('NF');
  });

  test('needs a WEB tag right after it', () => {
    expect(run('The.Long.Harbor.S01E01.NF.1080p.WEB-DL.x264-GRPA').streamingService).toBeUndefined();
    expect(run('The.Long.Harbor.S01E01.1080p.BluRay.AMZN.x264-GRPA').streamingService).toBeUndefined();
  });

  test('matches case-sensitively, so the Italian IT and the word "Now" are no service', () => {
    expect(run('Quiet.Orchard.2023.IT.WEB-DL.1080p-GRPA', { title: 'Quiet Orchard' }).streamingService).toBeUndefined();
    expect(run('Quiet.Orchard.2023.iT.WEB-DL.1080p-GRPA', { title: 'Quiet Orchard' }).streamingService).toBe('iT');
    expect(run('The.Long.Harbor.S01E01.Now.WEB-DL.1080p-GRPA').streamingService).toBeUndefined();
  });

  test('ignores title words', () => {
    expect(run('Max.Web.S01E01.1080p.HDTV.x264-GRPA', { title: 'Max Web' }).streamingService).toBeUndefined();
  });
});
