// The fake of Sonarr's scene-mapping service for the `test` compose profile
//: the backend's
// SCENE_MAPPINGS_URL, so no test reaches services.sonarr.tv. The names are
// invented, in the live list's shape (2026-11-19):
//
//   GET  /v1/scenemapping   the list
//   GET  /_fake/requests    the request log: path and User-Agent
//
//   SCENE_MAPPING_FAKE_PORT=4150 node e2e/fakes/scenemapping/server.ts
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';

export const SCENE_MAPPINGS = [
  { mappingId: 's-e2e000000000000000000001', tvdbId: 7700001, title: 'Harbour Lights UK', searchTitle: 'Harbour Lights', season: -1 },
  { mappingId: 's-e2e000000000000000000002', tvdbId: 7700001, title: 'The Harbour Lights', searchTitle: 'Harbour Lights', season: -1 },
  { mappingId: 's-e2e000000000000000000003', tvdbId: 7700001, title: 'Harbour Lights Winter Tales', searchTitle: 'Harbour Lights Winter Tales', season: 0 },
  {
    mappingId: 's-e2e000000000000000000004',
    tvdbId: 7700001,
    title: 'Harbour Lights Next Chapter',
    searchTitle: 'Harbour Lights Next Chapter',
    season: 2,
    sceneSeasonNumber: 1,
  },
  { mappingId: 's-e2e000000000000000000005', tvdbId: 7700001, title: 'Harbour Lights Far Future', searchTitle: 'Harbour Lights Far Future', season: 5 },
  { mappingId: 's-e2e000000000000000000006', tvdbId: 7700001, title: 'Harbour', searchTitle: 'Harbour', season: -1, filterRegex: '(?i)^Harbour\\.S01E' },
];

export type SceneMappingRequest = { at: number; path: string; userAgent?: string };

export function createSceneMappingFake(): { server: Server; requests: SceneMappingRequest[] } {
  const requests: SceneMappingRequest[] = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://scenemapping').pathname;
    if (path === '/_fake/requests') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify(requests));
    }
    requests.push({ at: Date.now(), path, userAgent: req.headers['user-agent'] });
    if (path !== '/v1/scenemapping' || req.method !== 'GET') return void res.writeHead(404).end('not found');
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(SCENE_MAPPINGS));
  });
  return { server, requests };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.SCENE_MAPPING_FAKE_PORT ?? 4150);
  createSceneMappingFake().server.listen(port, () => console.log(`Scene-mapping fake on :${port}, ${SCENE_MAPPINGS.length} mappings`));
}
