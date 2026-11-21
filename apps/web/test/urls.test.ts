// The browser's URLs: configured at container start, or built from the page's own address.
import { describe, expect, test } from 'vite-plus/test';

import { resolveUrls, rewriteStorageUrl } from '../lib/urls';

const ports = { convexPort: '3210', convexSitePort: '3211', jellyfinPort: '8096' };
const none = { convexUrl: '', convexSiteUrl: '', jellyfinPublicUrl: '', ...ports };

describe('resolveUrls', () => {
  test("unset: the page's protocol and hostname with each port", () => {
    expect(resolveUrls(none, { protocol: 'http:', hostname: '192.168.1.20' })).toEqual({
      convex: 'http://192.168.1.20:3210',
      convexSite: 'http://192.168.1.20:3211',
      jellyfin: 'http://192.168.1.20:8096',
    });
    expect(resolveUrls({ ...none, convexPort: '13210' }, { protocol: 'https:', hostname: 'nas.lan' }).convex).toBe('https://nas.lan:13210');
  });

  test('an IPv6 hostname is bracketed', () => {
    expect(resolveUrls(none, { protocol: 'http:', hostname: 'fd00::2' }).convex).toBe('http://[fd00::2]:3210');
    expect(resolveUrls(none, { protocol: 'http:', hostname: '[fd00::2]' }).jellyfin).toBe('http://[fd00::2]:8096');
  });

  test('set: the configured URLs, without a trailing slash', () => {
    expect(
      resolveUrls(
        {
          convexUrl: 'https://api.omnarr.example.net/',
          convexSiteUrl: 'https://auth.omnarr.example.net',
          jellyfinPublicUrl: 'https://jf.example.net/',
          ...ports,
        },
        { protocol: 'https:', hostname: 'omnarr.example.net' },
      ),
    ).toEqual({ convex: 'https://api.omnarr.example.net', convexSite: 'https://auth.omnarr.example.net', jellyfin: 'https://jf.example.net' });
  });
});

describe('rewriteStorageUrl', () => {
  test("the backend's loopback origin becomes the Convex URL the browser reaches", () => {
    expect(rewriteStorageUrl('http://127.0.0.1:3210/api/storage/abc?x=1', 'http://192.168.1.20:3210')).toBe('http://192.168.1.20:3210/api/storage/abc?x=1');
  });

  test('a relative path resolves against the Convex URL; any other URL is kept', () => {
    expect(rewriteStorageUrl('/api/storage/abc', 'https://api.example.net')).toBe('https://api.example.net/api/storage/abc');
    expect(rewriteStorageUrl('https://api.example.net/api/storage/abc', 'http://192.168.1.20:3210')).toBe('https://api.example.net/api/storage/abc');
    expect(rewriteStorageUrl('data:image/png;base64,AA', 'http://x:3210')).toBe('data:image/png;base64,AA');
  });
});
