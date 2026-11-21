// Trusted origins as a function of the request.
import { describe, expect, test } from 'vite-plus/test';

import { originsFor } from '../convex/setup/origins';

const from = (origin?: string) => new Request('http://backend:3211/api/auth/sign-in/username', origin ? { headers: { origin } } : {});

describe('with SITE_URL set: exact', () => {
  test.each(['https://omnarr.example.net', 'http://192.168.1.20:3000', undefined])('origin %s gets only the web URL', (origin) => {
    expect(originsFor(from(origin), { siteUrl: 'https://omnarr.example.net', webPort: '3000' })).toEqual(['https://omnarr.example.net']);
  });
});

describe('without SITE_URL: any host on the web port', () => {
  test.each(['http://192.168.1.20:3000', 'http://omnarr.lan:3000', 'https://nas.local:3000', 'http://[fd00::2]:3000'])('%s is trusted', (origin) => {
    expect(originsFor(from(origin), { webPort: '3000' })).toEqual([origin]);
  });

  test('no explicit port counts as 80 for http and 443 for https', () => {
    expect(originsFor(from('http://omnarr.lan'), { webPort: '80' })).toEqual(['http://omnarr.lan']);
    expect(originsFor(from('https://omnarr.lan'), { webPort: '443' })).toEqual(['https://omnarr.lan']);
    expect(originsFor(from('https://omnarr.lan'), { webPort: '80' })).toEqual([]);
  });

  test.each(['http://192.168.1.20:3001', 'http://192.168.1.20:3000/path', 'ftp://192.168.1.20:3000', 'null', 'garbage'])('%s is refused', (origin) => {
    expect(originsFor(from(origin), { webPort: '3000' })).toEqual([]);
  });

  test('no request or no Origin header trusts nothing', () => {
    expect(originsFor(undefined, { webPort: '3000' })).toEqual([]);
    expect(originsFor(from(), { webPort: '3000' })).toEqual([]);
  });

  test('WEB_PORT unset means 3000', () => {
    expect(originsFor(from('http://omnarr.lan:3000'), {})).toEqual(['http://omnarr.lan:3000']);
  });
});
