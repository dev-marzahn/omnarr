// parseRelease is total: 10,000 seeded strings, none of which may make it
// throw or return something the contract rejects.
import { ParsedRelease } from '@omnarr/contracts';
import { expect, test } from 'vite-plus/test';

import { parseRelease } from '../src/index.ts';

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOKENS = [
  'The',
  'Long',
  'Harbor',
  'S01E02',
  'S01',
  'E05',
  '2x03',
  'S01E01-E03',
  'S01-S03',
  '1071',
  '- 12',
  '(1071)',
  'v2',
  '2024.10.05',
  '2023',
  '1080p',
  '2160p',
  '720p',
  'WEB-DL',
  'WEBRip',
  'BluRay',
  'REMUX',
  'HDTV',
  'x264',
  'H.265',
  'HEVC',
  'DDP5.1',
  'Atmos',
  'DTS-X',
  'TrueHD',
  'DV',
  'HDR10+',
  '10bit',
  'MULTi',
  'GERMAN',
  'DL',
  'iT',
  'AMZN',
  'NF',
  'VOSTFR',
  'ENG.SUBS',
  'DUBBED',
  'REPACK',
  'PROPER',
  'COMPLETE',
  'Extras',
  '[SubGroup]',
  '-GRPA',
  '.mkv',
  '-Obfuscated',
  '[eztv]',
  'www.example.org -',
  '[req]',
];
const UNICODE = ['é', 'ü', 'ß', 'Ō', '日本', '한국', 'Ж', '🎬', '́', '​', '\u0000', '\n', '\t', '\\', '"', '(', ')', '[', ']', '-', '.', '_', ' '];
const SEPARATORS = ['.', ' ', '_', '-', '', ' - ', '.['];

function randomString(random: () => number): string {
  const roll = random();
  if (roll < 0.01) return '';
  const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)]!;
  if (roll < 0.03) {
    // A long string, up to 10,000 characters.
    const length = Math.floor(random() * 10_000);
    let text = '';
    while (text.length < length) text += pick(random() < 0.5 ? TOKENS : UNICODE) + pick(SEPARATORS);
    return text.slice(0, length);
  }
  const count = 1 + Math.floor(random() * 14);
  const parts: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const r = random();
    parts.push(r < 0.75 ? pick(TOKENS) : r < 0.9 ? pick(UNICODE) : String.fromCharCode(Math.floor(random() * 0xffff)));
  }
  return parts.join(pick(SEPARATORS));
}

test('parseRelease never throws and always returns a valid ParsedRelease', () => {
  const random = mulberry32(1);
  const failures: string[] = [];
  for (let i = 0; i < 10_000; i += 1) {
    const title = randomString(random);
    const kind = random() < 0.5 ? 'series' : 'movie';
    try {
      const result = ParsedRelease.safeParse(parseRelease(title, kind));
      if (!result.success) failures.push(`${JSON.stringify(title.slice(0, 120))} (${kind}): ${result.error.issues[0]?.message}`);
    } catch (error) {
      failures.push(`${JSON.stringify(title.slice(0, 120))} (${kind}) threw ${String(error)}`);
    }
  }
  expect(failures.slice(0, 10)).toEqual([]);
}, 120_000);
