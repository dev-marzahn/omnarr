// The fake definitions server's package: definitions written for
// omnarr's e2e in the Cardigann format. None is copied from Prowlarr's or
// Jackett's files, so the package's licence stays clean.
//
//   starsite     a public anime tracker (the fake site in server.ts): HTML rows
//                without magnets, so a grab goes through the download block;
//   starsite, broken  the same file with a filter omnarr doesn't know;
//   privy        a private site: listed, unsupported (privateInP2);
//   nyaasi       listed, unsupported (builtIn): Nyaa is added from the Site list.

export const STAR_SITE = (origin: string, filter = 'trim') => `---
id: starsite
name: Star Site
description: "The e2e's made-up public anime tracker"
language: en-US
type: public
encoding: UTF-8
links:
  - ${origin}/star/

caps:
  categorymappings:
    - {id: anime, cat: TV/Anime, desc: "Anime"}
  modes:
    search: [q]
    tv-search: [q, season, ep]

settings:
  - name: sort
    type: select
    label: Sort by
    default: added
    options:
      added: Date added
      seeders: Seeders
  - name: about
    type: info
    label: About
    default: "A fake site for the e2e."

search:
  paths:
    - path: "{{ if .Keywords }}search{{ else }}latest{{ end }}"
  inputs:
    q: "{{ .Keywords }}"
    sort: "{{ .Config.sort }}"
  rows:
    selector: "table#torrents > tbody > tr"
  fields:
    category:
      text: anime
    title:
      selector: td.name a
      filters:
        - name: ${filter}
    details:
      selector: td.name a
      attribute: href
    download:
      selector: td.name a
      attribute: href
    size:
      selector: td.size
    seeders:
      selector: td.seeders
    leechers:
      selector: td.leechers
    date:
      selector: td.added
      filters:
        - name: append
          args: " +00:00"
        - name: dateparse
          args: "yyyy-MM-dd HH:mm:ss zzz"

download:
  selectors:
    - selector: a.download
      attribute: href
`;

const PRIVY = `---
id: privy
name: Privy
description: "A made-up private tracker"
language: en-US
type: private
encoding: UTF-8
links:
  - https://privy.invalid/
caps:
  modes:
    search: [q]
settings:
  - name: username
    type: text
    label: Username
search:
  paths:
    - path: browse
  rows:
    selector: tr
  fields:
    title:
      selector: a
`;

const NYAA_LIKE = `---
id: nyaasi
name: Nyaa.si
description: "Listed so the catalogue shows it as built in"
language: en-US
type: public
encoding: UTF-8
links:
  - https://nyaa.invalid/
caps:
  modes:
    search: [q]
settings: []
search:
  paths:
    - path: "/"
  rows:
    selector: tr
  fields:
    title:
      selector: a
`;

/** The package's files: `broken` swaps in Star Site's failing update. */
export const packageFiles = (origin: string, broken: boolean): Record<string, string> => ({
  'starsite.yml': STAR_SITE(origin, broken ? 'sparkle' : 'trim'),
  'privy.yml': PRIVY,
  'nyaasi.yml': NYAA_LIKE,
});
