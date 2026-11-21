// Stored images are served by the Convex backend, another origin than the web app's.
import { describe, expect, test } from 'vite-plus/test';

import { mediaUrl } from '../lib/media';

describe('mediaUrl', () => {
  const convexUrl = 'http://127.0.0.1:54226';

  test("a relative storage path, as a self-hosted backend without CONVEX_CLOUD_ORIGIN gives it, resolves against the backend's URL", () => {
    expect(mediaUrl('/api/storage/1b78', convexUrl)).toBe('http://127.0.0.1:54226/api/storage/1b78');
  });

  test('an absolute URL and a data URI are kept', () => {
    expect(mediaUrl('https://omnarr.example/api/storage/1b78', convexUrl)).toBe('https://omnarr.example/api/storage/1b78');
    expect(mediaUrl('data:image/svg+xml;base64,PHN2Zz4=', convexUrl)).toBe('data:image/svg+xml;base64,PHN2Zz4=');
  });

  test('nothing stays nothing', () => {
    expect(mediaUrl(undefined, convexUrl)).toBeUndefined();
  });
});
