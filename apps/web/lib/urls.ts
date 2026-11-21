// The URLs the browser uses: each one the web container was started
// with (NUXT_PUBLIC_*), or, unset, the page's own protocol and hostname with
// that service's published port.

export type UrlConfig = {
  convexUrl: string;
  convexSiteUrl: string;
  jellyfinPublicUrl: string;
  convexPort: string;
  convexSitePort: string;
  jellyfinPort: string;
};
export type Urls = { convex: string; convexSite: string; jellyfin: string };

const trim = (url: string) => url.replace(/\/+$/, '');

export function resolveUrls(config: UrlConfig, location: { protocol: string; hostname: string }): Urls {
  const bare = location.hostname.replace(/^\[|\]$/g, '');
  const host = bare.includes(':') ? `[${bare}]` : bare;
  const built = (port: string) => `${location.protocol}//${host}:${port}`;
  return {
    convex: config.convexUrl ? trim(config.convexUrl) : built(config.convexPort),
    convexSite: config.convexSiteUrl ? trim(config.convexSiteUrl) : built(config.convexSitePort),
    jellyfin: config.jellyfinPublicUrl ? trim(config.jellyfinPublicUrl) : built(config.jellyfinPort),
  };
}

/** The backend's own origin when no Convex URL is set (CONVEX_CLOUD_ORIGIN's default). */
const LOOPBACK = 'http://127.0.0.1:3210';

/**
 * A file URL the backend returns (a support bundle, an image): its loopback
 * origin becomes the Convex URL the browser reaches; a relative path resolves
 * against that URL; anything else is kept.
 */
export function rewriteStorageUrl(url: string, convexUrl: string): string {
  if (url.startsWith(`${LOOPBACK}/`)) return `${trim(convexUrl)}${url.slice(LOOPBACK.length)}`;
  if (/^(https?:|data:|blob:)/i.test(url)) return url;
  return new URL(url, convexUrl).toString();
}
