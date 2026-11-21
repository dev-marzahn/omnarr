// A minimal NNTP server for the `test` compose profile: it serves
// the articles of the releases in ../usenet/catalogue.ts, and answers 430 for
// the parts a damaged release is missing. Enough of RFC 3977 and 4643 for a
// download client: CAPABILITIES, MODE READER, AUTHINFO USER/PASS, GROUP, DATE,
// ARTICLE, HEAD, BODY and STAT by message-id, and QUIT.
//
//   NNTP_FAKE_PORT=1119 NNTP_USERNAME=u NNTP_PASSWORD=p node e2e/fakes/nntp/server.ts
import { createServer, type Server, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';

import { loadCatalogue } from '../usenet/catalogue.ts';
import { articleBody, findArticle, GROUP, POSTER, subjectOf, type Release } from '../usenet/release.ts';

export type NntpFakeOptions = {
  releases: Release[];
  /** With a username, articles need AUTHINFO with these credentials; without one, any AUTHINFO is accepted and none is needed. */
  username?: string;
  password?: string;
  /** Serves the parts a damaged release is missing too, as a backup server that still has them would. */
  complete?: boolean;
};

export type NntpFake = {
  server: Server;
  /** Every command line received, in order, across connections; AUTHINFO PASS as `AUTHINFO PASS ***`. */
  requests: string[];
};

const ARTICLE_COMMANDS = new Set(['ARTICLE', 'HEAD', 'BODY', 'STAT', 'GROUP']);

/** A multi-line block: dot-stuffed, ended by a lone dot. */
const block = (text: string) => `${text.replace(/^\./gm, '..')}\r\n.`;

export function createNntpFake(options: NntpFakeOptions): NntpFake {
  const articleCount = options.releases.reduce((sum, release) => sum + release.parts.length, 0);
  const credentials = options.username === undefined ? undefined : { username: options.username, password: options.password ?? '' };
  const requests: string[] = [];
  const server = createServer((socket: Socket) => {
    const reply = (text: string) => socket.write(`${text}\r\n`, 'latin1');

    const article = (command: 'ARTICLE' | 'HEAD' | 'BODY' | 'STAT', args: string) => {
      const found = findArticle(options.releases, args);
      if (!found || (found.part.missing && !options.complete)) return reply('430 No such article');
      const { release, part } = found;
      const id = `<${part.messageId}>`;
      const headers = () =>
        [
          `From: ${POSTER}`,
          `Newsgroups: ${GROUP}`,
          `Subject: ${subjectOf(release, part.number)}`,
          `Date: ${new Date(release.postedAt).toUTCString()}`,
          'Path: omnarr.fake!not-for-mail',
          `Message-ID: ${id}`,
        ].join('\r\n');
      if (command === 'STAT') return reply(`223 0 ${id}`);
      if (command === 'HEAD') return reply(`221 0 ${id}\r\n${block(headers())}`);
      if (command === 'BODY') return reply(`222 0 ${id}\r\n${block(articleBody(release, part))}`);
      reply(`220 0 ${id}\r\n${block(`${headers()}\r\n\r\n${articleBody(release, part)}`)}`);
    };

    let signedIn = !credentials;
    let user: string | undefined;
    reply('200 omnarr NNTP fake ready');
    let buffer = '';
    // A client that drops the connection mid-reply must not take the server down.
    socket.on('error', () => socket.destroy());
    socket.setEncoding('latin1');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf('\r\n'); end >= 0; end = buffer.indexOf('\r\n')) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const space = line.indexOf(' ');
        const command = (space < 0 ? line : line.slice(0, space)).toUpperCase();
        const args = space < 0 ? '' : line.slice(space + 1).trim();
        const authinfo = command === 'AUTHINFO' ? /^(USER|PASS)\s+(.*)$/i.exec(args) : null;
        requests.push(authinfo?.[1]?.toUpperCase() === 'PASS' ? 'AUTHINFO PASS ***' : line);
        if (!signedIn && ARTICLE_COMMANDS.has(command)) {
          reply('480 Authentication required');
          continue;
        }
        switch (command) {
          case 'AUTHINFO': {
            const [, which = '', value = ''] = authinfo ?? [];
            if (which.toUpperCase() === 'USER') {
              user = value;
              reply('381 Password required');
            } else if (which.toUpperCase() === 'PASS') {
              if (user === undefined) reply('482 Authentication commands issued out of sequence');
              else if (!credentials || (user === credentials.username && value === credentials.password)) {
                signedIn = true;
                reply('281 Authentication accepted');
              } else reply('481 Authentication failed');
              user = undefined;
            } else reply('501 Syntax error');
            break;
          }
          case 'QUIT':
            socket.end('205 Bye\r\n');
            return;
          case 'CAPABILITIES':
            reply(`101 Capability list follows\r\n${block(['VERSION 2', 'READER', 'AUTHINFO USER'].join('\r\n'))}`);
            break;
          case 'MODE':
            reply(args.toUpperCase() === 'READER' ? '201 Reader mode, posting prohibited' : '501 Unknown mode');
            break;
          case 'GROUP':
            reply(args === GROUP ? `211 ${articleCount} 1 ${articleCount} ${GROUP}` : '411 No such group');
            break;
          case 'DATE':
            reply(`111 ${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`);
            break;
          case 'ARTICLE':
          case 'HEAD':
          case 'BODY':
          case 'STAT':
            article(command, args);
            break;
          default:
            reply('500 Unknown command');
        }
      }
    });
  });
  return { server, requests };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.NNTP_FAKE_PORT ?? 119);
  const username = process.env.NNTP_USERNAME || undefined;
  const releases = loadCatalogue();
  const complete = process.env.NNTP_COMPLETE === '1';
  createNntpFake({ releases, username, password: process.env.NNTP_PASSWORD, complete }).server.listen(port, () =>
    console.log(
      `NNTP fake on :${port}, ${releases.length} releases, ${username ? 'credentials required' : 'no credentials'}${complete ? ', no part missing' : ''}`,
    ),
  );
}
