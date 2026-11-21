# Coding standards

Reviewers check every change against these, beside the diff. Format, lint
and types are `vp check`'s; these are the calls no check can make. A breach
fails review.

## Code that deletes files

Every path that can delete or retire a file under the library or
`/data/originals` (`deleteLibraryFiles`, `retireOldVersions`, a swap's
`replacesPath`, `deleteWork`, the worker's `maintenance` and `prepare`
jobs) is the riskiest code in Omnarr: one wrong branch deletes the user's
only playable copy.

- **Stated beside the code.** The comment on the deleting function names
  which files it deletes and when, and the pull request says what changed
  in that list. A deletion the comment doesn't name fails review, even when
  it looks right.
- **The four cases tested.** A test for each kind of file the path can
  meet: a **scanned** file (the user's own), a **misread** one (parsed to
  the wrong Unit), a **kept original** (under `originals/`, its Publication
  gone), and a **pending** one (a Rendition or Publication not yet done).
  Each test asserts which files survive, not just which are deleted.
- **Paths checked.** A path built from data (a title, a client's
  `contentPath`) is tested with `..`, an empty string and a path outside its
  area.

## Queries on growing tables

A query a page reads (`query`, not an internal mutation) on a table that
grows with use (blocklist, grabs, jobs, events, search attempts) is bounded:
`.take(n)` or pagination, plus a `queryCost` test at the bound. A
`.collect()` on such a table fails review; a `.collect()` on an index
narrowed to one Work or Unit is fine.
