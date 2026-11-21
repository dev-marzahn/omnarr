// Hand-written Cardigann definitions and pages for the engine's tests. Every
// file here is written for omnarr's tests in the Cardigann format; none is
// copied from Prowlarr's or Jackett's definitions.

/** A small public HTML site: one search path, rows in a table, a details page with a download link. */
export const LANTERN_YML = `---
id: lanternsite
name: Lantern Site
description: "A made-up public tracker for tests"
language: en-US
type: public
encoding: UTF-8
requestDelay: 3
links:
  - https://lantern.test/
legacylinks:
  - https://old.lantern.test/

caps:
  categorymappings:
    - {id: 1, cat: TV/Anime, desc: "Anime"}
    - {id: 2, cat: Movies, desc: "Movies"}
    - {id: 3, cat: TV, desc: "TV", default: true}
  modes:
    search: [q]
    tv-search: [q, season, ep]
    movie-search: [q, imdbid]

settings:
  - name: sort
    type: select
    label: Sort
    default: added
    options:
      added: Date added
      seeders: Seeders
  - name: freeleech
    type: checkbox
    label: Free only
    default: false
  - name: info_note
    type: info
    label: About
    default: "Results are paced."

search:
  paths:
    - path: "{{ if .Keywords }}search/{{ .Keywords }}{{ else }}latest{{ end }}"
  inputs:
    cat: "{{ join .Categories \\",\\" }}"
    order: "{{ .Config.sort }}"
    free: "{{ if .Config.freeleech }}1{{ else }}{{ end }}"
  keywordsfilters:
    - name: re_replace
      args: ["\\\\bS0?(\\\\d+)E(\\\\d+)\\\\b", "$1x$2"]
  rows:
    selector: table.results > tbody > tr:has(a.title)
  fields:
    category:
      selector: td.cat a
      attribute: href
      filters:
        - name: querystring
          args: c
    title:
      selector: a.title
    details:
      selector: a.title
      attribute: href
    download:
      selector: a.dl
      attribute: href
    magnet:
      optional: true
      selector: a[href^="magnet:"]
      attribute: href
    size:
      selector: td.size
    seeders:
      selector: td.seed
    leechers:
      selector: td.leech
    date:
      selector: td.date
      filters:
        - name: append
          args: " +00:00"
        - name: dateparse
          args: "yyyy-MM-dd HH:mm zzz"
    _free:
      optional: true
      selector: span.free
    downloadvolumefactor:
      text: "{{ if .Result._free }}0{{ else }}1{{ end }}"
    uploadvolumefactor:
      text: 1
`;

export const LANTERN_PAGE = `<!doctype html><html><head><title>Lantern</title></head><body>
<table class="results"><thead><tr><th>Cat</th><th>Name</th></tr></thead><tbody>
<tr><td class="cat"><a href="/browse?c=1">Anime</a></td><td><a class="title" href="/torrent/101">[Grp] Star Lantern - 02 (1080p)</a></td>
<td><a class="dl" href="/get/101.torrent">dl</a><a href="magnet:?xt=urn:btih:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&dn=x">m</a></td>
<td class="size">1.5 GiB</td><td class="seed">12</td><td class="leech">3</td><td class="date">2025-03-04 05:06</td></tr>
<tr><td class="cat"><a href="/browse?c=2">Movies</a></td><td><a class="title" href="/torrent/102">Lantern Movie 2024 1080p</a><span class="free">FL</span></td>
<td><a class="dl" href="/get/102.torrent">dl</a></td>
<td class="size">4,2 GB</td><td class="seed">1,024</td><td class="leech">-</td><td class="date">2025-03-05 06:07</td></tr>
<tr><td colspan="7">ad row without a title</td></tr>
</tbody></table></body></html>`;

export const LANTERN_EMPTY = `<!doctype html><html><body><table class="results"><tbody></tbody></table><p>No torrents found</p></body></html>`;

/** A JSON API site. */
export const JSONSITE_YML = `---
id: jsonsite
name: Json Site
description: "A made-up JSON API"
language: en-US
type: public
encoding: UTF-8
links:
  - https://api.json.test/
caps:
  categories:
    movies: Movies
  modes:
    search: [q]
    movie-search: [q, imdbid]
settings: []
search:
  paths:
    - path: api/list.json
      response:
        type: json
        noResultsMessage: '"count":0'
  inputs:
    query: "{{ .Keywords }}"
    imdb: "{{ .Query.IMDBID }}"
  rows:
    selector: data.items:has(imdb_code)
    attribute: torrents
    multiple: true
  fields:
    title:
      selector: ..name
    _quality:
      selector: quality
    title|append:
      text: " {{ .Result._quality }}"
    infohash:
      selector: hash
    category:
      text: movies
    size:
      selector: size_bytes
    seeders:
      selector: seeds
    leechers:
      selector: peers
    date:
      selector: ..uploaded_unix
    imdbid:
      selector: ..imdb_code
    details:
      selector: ..url
`;

export const JSONSITE_BODY = JSON.stringify({
  data: {
    count: 2,
    items: [
      {
        name: 'Lantern Movie',
        imdb_code: 'tt0123456',
        url: 'https://api.json.test/movie/7',
        uploaded_unix: 1741064767,
        torrents: [
          { quality: '1080p', hash: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', size_bytes: 2147483648, seeds: 5, peers: 2 },
          { quality: '720p', hash: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', size_bytes: 1073741824, seeds: 3, peers: 1 },
        ],
      },
      { name: 'No hash here', torrents: [] },
    ],
  },
});

/** Replaces `from` with `to` in a definition, for the support check's cases. */
export const variant = (yml: string, from: string, to: string) => {
  if (!yml.includes(from)) throw new Error(`fixture has no ${from}`);
  return yml.replace(from, to);
};
