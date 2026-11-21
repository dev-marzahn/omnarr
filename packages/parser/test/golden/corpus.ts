// Loads the golden corpus and compares a parse with a case.
import { readFileSync } from 'node:fs';

import { ParsedRelease } from '@omnarr/contracts';
import { z } from 'zod';

export const FILES = ['series', 'anime', 'movies', 'daily', 'packs', 'edge'] as const;
export type CorpusFile = (typeof FILES)[number];

/** `null` in `expected` means the field must be absent. */
const expectedShape = Object.fromEntries(
  Object.entries(ParsedRelease.shape).map(([key, schema]) => [key, schema instanceof z.ZodOptional ? schema.unwrap().nullable() : schema]),
);
const Expected = z.object(expectedShape).partial().strict();
export type Expected = { [K in keyof ParsedRelease]?: ParsedRelease[K] | null };

export const Case = z
  .object({
    title: z.string(),
    kind: z.enum(['series', 'movie']),
    expected: Expected,
    source: z.enum(['indexer', 'handwritten']),
    addedIn: z.string(),
  })
  .strict();
export type Case = Omit<z.infer<typeof Case>, 'expected'> & { expected: Expected; file: CorpusFile; line: number };

export function loadCorpus(): Case[] {
  return FILES.flatMap((file) =>
    readFileSync(new URL(`./${file}.jsonl`, import.meta.url), 'utf8')
      .split('\n')
      .map((text, index) => ({ text, line: index + 1 }))
      .filter(({ text }) => text.trim() !== '')
      .map(({ text, line }) => {
        const parsed = Case.safeParse(JSON.parse(text));
        if (!parsed.success) throw new Error(`${file}.jsonl:${line}: ${parsed.error.message}`);
        return { ...parsed.data, file, line };
      }),
  );
}

const withoutUnparsed = (notes: string[]) => notes.filter((note) => !note.startsWith('unparsedTokens:'));

/** JSON with object keys sorted, so `edition` compares by content; arrays keep their order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonical(inner)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Whether an expected value is "non-empty" for the corpus rule: set, true, a non-empty list or object, a revision above the first. */
function isNonEmpty(field: string, value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (field === 'revision') {
    const revision = value as ParsedRelease['revision'];
    return revision.version > 1 || revision.real > 0 || revision.repack;
  }
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/** The counts the corpus rule is checked against. */
export function corpusRule(cases: Case[]) {
  const fields = Object.keys(ParsedRelease.shape).map((field) => ({
    field,
    count: cases.filter((c) => isNonEmpty(field, c.expected[field as keyof Case['expected']])).length,
  }));
  const inFile = (file: CorpusFile) => cases.filter((c) => c.file === file).length;
  const categories = [
    { name: 'anime cases', minimum: 50, count: inFile('anime') },
    { name: 'packs (full, partial, multi-season)', minimum: 50, count: inFile('packs') },
    { name: 'daily cases', minimum: 20, count: inFile('daily') },
    { name: 'movie cases', minimum: 50, count: inFile('movies') },
    {
      name: 'multi-episode cases',
      minimum: 30,
      count: cases.filter((c) => (c.expected.episodes?.filter((e) => e.episode !== undefined || e.absolute !== undefined).length ?? 0) >= 2).length,
    },
    { name: 'cases with language tags', minimum: 30, count: cases.filter((c) => (c.expected.languages?.length ?? 0) > 0).length },
    { name: 'cases with no language tag', minimum: 30, count: cases.filter((c) => c.expected.notes?.includes('languageAssumed')).length },
    {
      name: 'WEB-DL cases that must not get multi',
      minimum: 30,
      count: cases.filter((c) => /web-?dl/i.test(c.title) && Array.isArray(c.expected.languages) && !c.expected.languages.includes('multi')).length,
    },
  ];
  return { fields, categories, total: cases.length, indexerCases: cases.filter((c) => c.source === 'indexer').length };
}

/** Field-level differences between a parse and a case's expectations; `notes` is always compared. */
export function diff(actual: ParsedRelease, expected: Case['expected']): string[] {
  const lines: string[] = [];
  const fields = { ...expected, notes: expected.notes ?? [] };
  for (const [field, want] of Object.entries(fields)) {
    const raw = actual[field as keyof ParsedRelease];
    const got = field === 'notes' ? withoutUnparsed(raw as string[]) : raw;
    const wanted = want === null ? undefined : want;
    if (canonical(got) !== canonical(wanted)) lines.push(`${field}: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(got)}`);
  }
  return lines;
}
