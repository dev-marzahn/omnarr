// pin-images: the release workflow's step that writes the project's three digests into compose.yml.
import { describe, expect, test } from 'vite-plus/test';

import { pinImages } from './pin-images.ts';

const d = (c: string) => `sha256:${c.repeat(64)}`;
const COMPOSE = `# The direct layout.
name: omnarr
services:
  setup:
    # The worker image's setup command.
    image: ghcr.io/dev-marzahn/omnarr-worker:0.1.0-p1@${d('0')}
  backend:
    image: ghcr.io/dev-marzahn/omnarr-backend:0.1.0-p1@${d('0')}
  worker:
    image: ghcr.io/dev-marzahn/omnarr-worker:0.1.0-p1@${d('0')}
  web:
    image: ghcr.io/dev-marzahn/omnarr-web:0.1.0-p1
  jellyfin:
    image: jellyfin/jellyfin:12.4@${d('f')}
`;
const digests = { 'omnarr-backend': d('b'), 'omnarr-worker': d('c'), 'omnarr-web': d('e') };

describe('pinImages', () => {
  test('rewrites the three project images, keeps comments, order and the third-party pins', () => {
    const out = pinImages(COMPOSE, '0.2.0', digests);
    expect(out).toBe(
      COMPOSE.replaceAll(`omnarr-worker:0.1.0-p1@${d('0')}`, `omnarr-worker:0.2.0@${d('c')}`)
        .replace(`omnarr-backend:0.1.0-p1@${d('0')}`, `omnarr-backend:0.2.0@${d('b')}`)
        .replace('omnarr-web:0.1.0-p1\n', `omnarr-web:0.2.0@${d('e')}\n`),
    );
  });

  test('fails on an unknown or a missing image, or a bad digest', () => {
    expect(() => pinImages(COMPOSE, '0.2.0', { ...digests, 'omnarr-gateway': d('1') })).toThrow('unknown image omnarr-gateway');
    const { 'omnarr-web': _, ...partial } = digests;
    expect(() => pinImages(COMPOSE, '0.2.0', partial)).toThrow('no digest for omnarr-web');
    expect(() => pinImages(COMPOSE, '0.2.0', { ...digests, 'omnarr-web': 'latest' })).toThrow('omnarr-web: latest is not a sha256 digest');
    expect(() => pinImages(COMPOSE.replace(/ {2}web:\n.*\n/, ''), '0.2.0', digests)).toThrow('compose.yml has no omnarr-web image');
  });
});
