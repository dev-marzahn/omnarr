import { connect, type AddressInfo, type Socket } from 'node:net';

import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test';

import { articleBody, createRelease } from '../usenet/release.ts';
import { createNntpFake, type NntpFakeOptions } from './server.ts';

const content = Uint8Array.from({ length: 10_000 }, (_, index) => index % 256);
const good = createRelease({ guid: 'good', title: 'Good', fileName: 'good.mkv' }, content, { partSize: 2000 });
const bad = createRelease({ guid: 'bad', title: 'Bad', fileName: 'bad.mkv', damaged: true }, content, { partSize: 2000 });

/** Codes whose response is multi-line, ended by a lone dot. */
const MULTI_LINE = new Set(['101', '220', '221', '222']);

/** A line-reading NNTP client: `send` resolves to the response, multi-line ones with the dot-stuffing left in. */
async function client(port: number) {
  const socket: Socket = connect(port, '127.0.0.1');
  socket.setEncoding('latin1');
  let buffer = '';
  let waiting: (() => void) | undefined;
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    waiting?.();
  });
  const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()));
  const complete = () => {
    const end = buffer.indexOf('\r\n');
    if (end < 0) return undefined;
    if (!MULTI_LINE.has(buffer.slice(0, 3))) return end + 2;
    const terminator = buffer.indexOf('\r\n.\r\n', end - 2);
    return terminator < 0 ? undefined : terminator + 5;
  };
  const read = async () => {
    let length = complete();
    while (length === undefined) {
      await new Promise<void>((resolve) => (waiting = resolve));
      length = complete();
    }
    const response = buffer.slice(0, length);
    buffer = buffer.slice(length);
    return response;
  };
  const greeting = await read();
  return {
    greeting,
    write: (raw: string) => socket.write(raw),
    read,
    send: (line: string) => {
      socket.write(`${line}\r\n`);
      return read();
    },
    closed,
    end: () => socket.destroy(),
  };
}

function serve(options: NntpFakeOptions) {
  const fake = createNntpFake(options);
  const sessions: Awaited<ReturnType<typeof client>>[] = [];
  let port = 0;
  beforeAll(async () => {
    await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
    port = (fake.server.address() as AddressInfo).port;
  });
  afterAll(() => {
    for (const session of sessions) session.end();
    return new Promise<void>((resolve) => fake.server.close(() => resolve()));
  });
  return {
    fake,
    connect: async () => {
      const session = await client(port);
      sessions.push(session);
      return session;
    },
  };
}

describe('the NNTP fake as a complete backup server', () => {
  const { connect: open } = serve({ releases: [bad], complete: true });

  test('serves the parts a damaged release is missing, as a backup that still has them', async () => {
    const session = await open();
    const answers = [];
    for (const part of bad.parts) answers.push((await session.send(`BODY <${part.messageId}>`)).slice(0, 3));
    expect(answers).toEqual(['222', '222', '222', '222', '222']);
    session.end();
  });
});

describe('the NNTP fake, without credentials', () => {
  const { connect: open } = serve({ releases: [good, bad] });

  test('greets with 200 and says goodbye to QUIT with 205, closing the connection', async () => {
    const session = await open();
    expect(session.greeting).toMatch(/^200 /);
    expect(await session.send('QUIT')).toMatch(/^205 /);
    await session.closed;
  });

  test('serves BODY <message-id> as the yEnc part, ended by a lone dot', async () => {
    const session = await open();
    const part = good.parts[2]!;
    const response = await session.send(`BODY <${part.messageId}>`);
    expect(response.startsWith(`222 0 <${part.messageId}>\r\n`)).toBe(true);
    expect(response.endsWith('\r\n.\r\n')).toBe(true);
    const body = response.slice(response.indexOf('\r\n') + 2, -5);
    expect(body).toBe(articleBody(good, part));
    session.end();
  });

  test('answers 430 for an unknown article and for the parts a damaged release is missing', async () => {
    const session = await open();
    expect(await session.send('BODY <nope@omnarr.fake>')).toMatch(/^430 /);
    const answers = [];
    for (const part of bad.parts) answers.push((await session.send(`BODY <${part.messageId}>`)).slice(0, 3));
    expect(answers).toEqual(['222', '430', '222', '430', '222']);
    for (const command of ['ARTICLE', 'HEAD', 'STAT']) expect(await session.send(`${command} <${bad.parts[1]!.messageId}>`)).toMatch(/^430 /);
    session.end();
  });

  test('serves HEAD, ARTICLE and STAT for an article, with its subject, group and message-id', async () => {
    const session = await open();
    const id = `<${good.parts[0]!.messageId}>`;
    const head = await session.send(`head ${id}`);
    expect(head).toMatch(new RegExp(`^221 0 ${id}\r\n`));
    expect(head).toContain('\r\nSubject: "good.mkv" yEnc (1/5)\r\n');
    expect(head).toContain('\r\nNewsgroups: alt.binaries.omnarr\r\n');
    expect(head).toContain(`\r\nMessage-ID: ${id}\r\n`);
    expect(head.endsWith('\r\n.\r\n')).toBe(true);
    const article = await session.send(`ARTICLE ${id}`);
    expect(article).toMatch(new RegExp(`^220 0 ${id}\r\n`));
    // The headers, a blank line, then the body.
    expect(article).toContain(`\r\nMessage-ID: ${id}\r\n\r\n=ybegin part=1 total=5 `);
    expect(await session.send(`STAT ${id}`)).toBe(`223 0 ${id}\r\n`);
    session.end();
  });

  test('answers CAPABILITIES, MODE READER, GROUP and DATE, and 500 to anything else', async () => {
    const session = await open();
    expect(await session.send('CAPABILITIES')).toMatch(/^101 [^\r]*\r\nVERSION 2\r\nREADER\r\n(?:[^\r]*\r\n)*\.\r\n$/);
    expect(await session.send('MODE READER')).toMatch(/^20[01] /);
    expect(await session.send('GROUP alt.binaries.omnarr')).toMatch(/^211 \d+ \d+ \d+ alt\.binaries\.omnarr\r\n$/);
    expect(await session.send('GROUP alt.binaries.elsewhere')).toMatch(/^411 /);
    expect(await session.send('DATE')).toMatch(/^111 \d{14}\r\n$/);
    expect(await session.send('POST')).toMatch(/^500 /);
    session.end();
  });

  test('accepts any AUTHINFO USER and PASS', async () => {
    const session = await open();
    expect(await session.send('AUTHINFO USER anyone')).toMatch(/^381 /);
    expect(await session.send('AUTHINFO PASS anything')).toMatch(/^281 /);
    session.end();
  });
});

describe('the NNTP fake, with credentials', () => {
  const { fake, connect: open } = serve({ releases: [good], username: 'nzbget', password: 's3cret' });
  const id = `<${good.parts[0]!.messageId}>`;

  test('refuses articles with 480 until the client signs in, and accepts the configured credentials with 281', async () => {
    const session = await open();
    expect(await session.send(`BODY ${id}`)).toMatch(/^480 /);
    expect(await session.send('AUTHINFO USER nzbget')).toMatch(/^381 /);
    expect(await session.send('AUTHINFO PASS s3cret')).toMatch(/^281 /);
    expect(await session.send(`BODY ${id}`)).toMatch(/^222 /);
    session.end();
  });

  test('answers a wrong user or password with 481', async () => {
    const session = await open();
    await session.send('AUTHINFO USER nzbget');
    expect(await session.send('AUTHINFO PASS wrong')).toMatch(/^481 /);
    await session.send('AUTHINFO USER someone');
    expect(await session.send('AUTHINFO PASS s3cret')).toMatch(/^481 /);
    expect(await session.send(`STAT ${id}`)).toMatch(/^480 /);
    session.end();
  });

  test('records every command, with passwords left out', async () => {
    fake.requests.length = 0;
    const session = await open();
    await session.send('AUTHINFO USER nzbget');
    await session.send('AUTHINFO PASS s3cret');
    await session.send(`BODY ${id}`);
    session.end();
    expect(fake.requests).toEqual(['AUTHINFO USER nzbget', 'AUTHINFO PASS ***', `BODY ${id}`]);
    expect(JSON.stringify(fake.requests)).not.toContain('s3cret');
  });

  test('answers commands that arrive together in one packet, or split across packets, in order', async () => {
    const session = await open();
    session.write(`AUTHINFO USER nzbget\r\nAUTHINFO PASS s3cret\r\nSTAT ${id}\r\nST`);
    expect([await session.read(), await session.read(), await session.read()].map((reply) => reply.slice(0, 3))).toEqual(['381', '281', '223']);
    session.write(`AT ${id}\r\n`);
    expect(await session.read()).toMatch(/^223 /);
    session.end();
  });
});
