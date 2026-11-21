// Trusted origins, for Better Auth's origin check and its CORS
// layer alike. Nothing here imports _generated/: the Better Auth CLI loads
// authOptions.ts, which uses this, before codegen.
//
// With SITE_URL (OMNARR_WEB_URL) set, only that origin. Without it, the
// request's Origin when it is http(s)://<any host>[:port] with no path and its
// port is WEB_PORT; an Origin without a port counts as 80 or 443.

export function originsFor(request: Request | undefined, { siteUrl, webPort }: { siteUrl?: string; webPort?: string }): string[] {
  if (siteUrl) return [siteUrl];
  const origin = request?.headers.get('origin');
  if (!origin) return [];
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return [];
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== origin) return [];
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return port === (webPort || '3000') ? [origin] : [];
}
