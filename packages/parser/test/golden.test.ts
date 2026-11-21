// The golden corpus gate: every case's listed fields and its notes
// must match. There is no update mode: an expectation changes only by editing
// its line.
import { describe, expect, test } from 'vite-plus/test';

import { parseRelease } from '../src/index.ts';
import { corpusRule, diff, FILES, loadCorpus } from './golden/corpus.ts';

const corpus = loadCorpus();

describe.each(FILES)('golden/%s.jsonl', (file) => {
  const cases = corpus.filter((c) => c.file === file);
  test.each(cases.map((c) => [`${c.line}: ${c.title}`, c] as const))('%s', (_name, c) => {
    expect(diff(parseRelease(c.title, c.kind), c.expected)).toEqual([]);
  });
});

describe('the corpus rule', () => {
  const rule = corpusRule(corpus);

  test.each(rule.fields.map((f) => [f.field, f.count] as const))('at least 20 cases set %s (has %i)', (_field, count) => {
    expect(count).toBeGreaterThanOrEqual(20);
  });

  test.each(rule.categories.map((c) => [c.name, c.minimum, c.count] as const))('at least %s: %i (has %i)', (_name, minimum, count) => {
    expect(count).toBeGreaterThanOrEqual(minimum);
  });

  // The author labels the `indexer` cases from their own feeds (collect-titles);
  // until the first one is committed, this part of the rule can't be met.
  test.skipIf(rule.indexerCases === 0)(`at least 500 cases, 250 of them from indexers (has ${rule.total}, ${rule.indexerCases} from indexers)`, () => {
    expect(rule.total).toBeGreaterThanOrEqual(500);
    expect(rule.indexerCases).toBeGreaterThanOrEqual(250);
  });
});

describe('the corpus itself', () => {
  test('no title appears twice', () => {
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const c of corpus) {
      const at = `${c.file}.jsonl:${c.line}`;
      if (seen.has(c.title)) duplicates.push(`${c.title} (${seen.get(c.title)} and ${at})`);
      else seen.set(c.title, at);
    }
    expect(duplicates).toEqual([]);
  });
});
