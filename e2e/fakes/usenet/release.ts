// A release as both fakes serve it: one file split into parts,
// one article per part, named by the release guid and the part number. The
// Newznab fake serves its NZB, the NNTP fake its articles. A damaged release
// has articles that the NNTP fake answers 430 for, and no par2 files, so a
// download client cannot repair it.
import { yencPart } from './yenc.ts';

export const GROUP = 'alt.binaries.omnarr';
export const POSTER = 'omnarr fake <poster@omnarr.fake>';
export const DEFAULT_PART_SIZE = 256 * 1024;

export type ReleaseEntry = {
  guid: string;
  title: string;
  fileName: string;
  /** The NNTP fake answers 430 for every other part after the first. */
  damaged?: boolean;
  /** The Newznab fake lists it under every search, as an indexer that ignores the numbers does, for the manual-grab case. */
  everyQuery?: boolean;
};

export type Part = {
  /** 1-based. */
  number: number;
  /** Byte offsets into the file, `end` exclusive. */
  begin: number;
  end: number;
  /** Without angle brackets, as an NZB segment writes it. */
  messageId: string;
  /** The NNTP fake has no such article. */
  missing: boolean;
};

export type Release = {
  entry: ReleaseEntry;
  content: Uint8Array;
  parts: Part[];
  /** ISO 8601: the articles' Date and the NZB's date. */
  postedAt: string;
};

export type ReleaseOptions = { partSize?: number; postedAt?: string };

export function createRelease(entry: ReleaseEntry, content: Uint8Array, options: ReleaseOptions = {}): Release {
  const partSize = options.partSize ?? DEFAULT_PART_SIZE;
  const total = Math.max(1, Math.ceil(content.length / partSize));
  const parts = Array.from({ length: total }, (_, index): Part => {
    const number = index + 1;
    return {
      number,
      begin: index * partSize,
      end: Math.min(content.length, number * partSize),
      messageId: `${entry.guid}.p${number}of${total}@omnarr.fake`,
      missing: entry.damaged === true && number > 1 && number % 2 === 0,
    };
  });
  return { entry, content, parts, postedAt: options.postedAt ?? '2026-11-01T00:00:00Z' };
}

/** The part's article body: yEnc, before NNTP dot-stuffing. */
export function articleBody(release: Release, part: Part): string {
  return yencPart({
    file: release.content,
    name: release.entry.fileName,
    part: part.number,
    total: release.parts.length,
    begin: part.begin,
    end: part.end,
  });
}

export const subjectOf = (release: Release, part: number) => `"${release.entry.fileName}" yEnc (${part}/${release.parts.length})`;

const bare = (messageId: string) => messageId.replace(/^<|>$/g, '');

export function findArticle(releases: Release[], messageId: string): { release: Release; part: Part } | undefined {
  const id = bare(messageId);
  for (const release of releases) {
    const part = release.parts.find((candidate) => candidate.messageId === id);
    if (part) return { release, part };
  }
  return undefined;
}

const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function nzbXml(release: Release): string {
  const date = Math.floor(Date.parse(release.postedAt) / 1000);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE nzb PUBLIC "-//newzBin//DTD NZB 1.1//EN" "http://www.newzbin.com/DTD/nzb/nzb-1.1.dtd">',
    '<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">',
    `  <head><meta type="title">${escape(release.entry.title)}</meta></head>`,
    `  <file poster="${escape(POSTER)}" date="${date}" subject="${escape(subjectOf(release, 1))}">`,
    `    <groups><group>${GROUP}</group></groups>`,
    '    <segments>',
    ...release.parts.map((part) => `      <segment bytes="${articleBody(release, part).length}" number="${part.number}">${escape(part.messageId)}</segment>`),
    '    </segments>',
    '  </file>',
    '</nzb>',
    '',
  ].join('\n');
}
