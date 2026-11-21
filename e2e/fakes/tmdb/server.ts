// A fake TMDB v3 API for the `test` compose profile. It serves
// the catalogue in fixtures.ts through the fetch handler in handler.ts.
//
//   PORT=8000 TMDB_API_KEY=test-key node e2e/fakes/tmdb/server.ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';

import { createTmdbHandler, type TmdbFakeOptions } from './handler.ts';

export type { TmdbFakeOptions } from './handler.ts';

export function createTmdbFake(options: TmdbFakeOptions): Server {
  const handle = createTmdbHandler(options);
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(name, value);
    const response = handle(new Request(new URL(req.url ?? '/', 'http://tmdb.fake'), { method: req.method, headers }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(await response.text());
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8000);
  const apiKey = process.env.TMDB_API_KEY ?? 'test-tmdb-key';
  createTmdbFake({ apiKey }).listen(port, () => console.log(`TMDB fake on :${port}`));
}
