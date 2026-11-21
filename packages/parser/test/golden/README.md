# Golden corpus

The parser's golden corpus. `golden.test.ts` parses every line and fails on any difference, printing the fields that differ. There is no update mode: an expectation changes only by editing its line.

## Source and licence

- **`handwritten` cases** were written for this project by its implementers, starting 2026-11-17, with made-up show names (`The Long Harbor`, `Quiet Orchard`, `Lantern Keeper` and others) and made-up groups.
- **`indexer` cases** are titles the author collected from their own indexers with `scripts/collect-titles.ts` and labelled by hand. Each records the milestone it was added in.
- No title comes from Sonarr's, Radarr's or any other project's tests.

## Format

One JSON object a line, in the file for its kind of release (`series`, `anime`, `movies`, `daily`, `packs`, `edge`):

```json
{
  "title": "…",
  "kind": "series",
  "expected": { "episodes": [{ "season": 1, "episode": 2 }], "notes": ["languageAssumed"] },
  "source": "handwritten",
  "addedIn": "M2"
}
```

- `expected` lists only the fields the case checks. `null` means the field must be absent.
- `notes` is always checked, as `[]` when not listed, except `unparsedTokens:` entries.
- Objects (`edition`, `pack`, `revision`) compare by content; lists compare in order.
- A title appears once in the whole corpus.

## The corpus rule

`golden.test.ts` also checks the corpus against a coverage rule: at least 20 cases setting each `ParsedRelease` field, and the category minimums (50 anime, 50 packs, 20 daily, 50 movies, 30 multi-episode, 30 with language tags, 30 without, 30 `WEB-DL` titles without `multi`). The "500 cases, 250 from indexers" part runs once the first `indexer` case is committed.
