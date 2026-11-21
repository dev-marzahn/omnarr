import { describe, expect, test } from 'vite-plus/test';

import { articleBody, createRelease, findArticle, nzbXml } from './release.ts';

const content = Uint8Array.from({ length: 10_000 }, (_, index) => index % 251);
const entry = { guid: 'show-s01e01', title: 'Show.S01E01.1080p.WEB-DL-GRP', fileName: 'Show.S01E01.1080p.WEB-DL-GRP.mkv' };

describe('createRelease', () => {
  test('splits the file into parts of the given size, the last one shorter', () => {
    const release = createRelease(entry, content, { partSize: 3000 });
    expect(release.parts.map(({ number, begin, end }) => [number, begin, end])).toEqual([
      [1, 0, 3000],
      [2, 3000, 6000],
      [3, 6000, 9000],
      [4, 9000, 10_000],
    ]);
  });

  test('splits into parts of 256 KiB by default', () => {
    expect(createRelease(entry, new Uint8Array(600 * 1024)).parts.map((part) => part.end - part.begin)).toEqual([262_144, 262_144, 90_112]);
  });

  test('names each article by the guid and its part number', () => {
    const release = createRelease(entry, content, { partSize: 3000 });
    expect(release.parts.map((part) => part.messageId)).toEqual([
      'show-s01e01.p1of4@omnarr.fake',
      'show-s01e01.p2of4@omnarr.fake',
      'show-s01e01.p3of4@omnarr.fake',
      'show-s01e01.p4of4@omnarr.fake',
    ]);
  });

  test('a damaged release is missing every other part after the first', () => {
    const release = createRelease({ ...entry, damaged: true }, content, { partSize: 2000 });
    expect(release.parts.filter((part) => part.missing).map((part) => part.number)).toEqual([2, 4]);
    expect(createRelease(entry, content, { partSize: 2000 }).parts.some((part) => part.missing)).toBe(false);
  });
});

describe('articleBody', () => {
  test('is the part yEnc-encoded under the release file name', () => {
    const release = createRelease(entry, content, { partSize: 3000 });
    const body = articleBody(release, release.parts[1]!);
    expect(body.split('\r\n').slice(0, 2)).toEqual([
      '=ybegin part=2 total=4 line=128 size=10000 name=Show.S01E01.1080p.WEB-DL-GRP.mkv',
      '=ypart begin=3001 end=6000',
    ]);
  });
});

describe('findArticle', () => {
  test('finds a part by message-id across releases, with or without angle brackets', () => {
    const one = createRelease(entry, content, { partSize: 3000 });
    const two = createRelease({ ...entry, guid: 'other' }, content, { partSize: 5000 });
    expect(findArticle([one, two], '<other.p2of2@omnarr.fake>')).toEqual({ release: two, part: two.parts[1] });
    expect(findArticle([one, two], 'show-s01e01.p1of4@omnarr.fake')?.part.number).toBe(1);
    expect(findArticle([one, two], '<nope@omnarr.fake>')).toBeUndefined();
  });
});

describe('nzbXml', () => {
  test('lists one file with its subject, group and every segment, damaged ones included', () => {
    const release = createRelease({ ...entry, title: 'A&B', damaged: true }, content, { partSize: 5000 });
    const nzb = nzbXml(release);
    expect(nzb).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>/);
    expect(nzb).toContain('<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">');
    expect(nzb).toContain('<meta type="title">A&amp;B</meta>');
    expect(nzb).toMatch(/<file poster="[^"]+" date="\d+" subject="&quot;Show.S01E01.1080p.WEB-DL-GRP.mkv&quot; yEnc \(1\/2\)">/);
    expect(nzb).toContain('<groups><group>alt.binaries.omnarr</group></groups>');
    const segments = [...nzb.matchAll(/<segment bytes="(\d+)" number="(\d+)">([^<]+)<\/segment>/g)];
    expect(segments.map((m) => [m[2], m[3]])).toEqual([
      ['1', 'show-s01e01.p1of2@omnarr.fake'],
      ['2', 'show-s01e01.p2of2@omnarr.fake'],
    ]);
    // A segment's bytes are its encoded article's: a little over the part's 5000.
    for (const m of segments) expect(Number(m[1])).toBeGreaterThan(5000);
  });
});
