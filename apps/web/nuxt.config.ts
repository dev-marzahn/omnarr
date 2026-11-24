// The web app: Nuxt UI and a Convex client authenticated by the Better Auth
// session.
export default defineNuxtConfig({
  compatibilityDate: '2026-11-01',
  // The repo's layout (pages/, layouts/, plugins/ at the app root), not Nuxt 4's app/.
  srcDir: '.',
  // An admin app behind a login, talking to Convex over a WebSocket from the
  // browser: nothing to render on the server.
  ssr: false,
  modules: ['@nuxt/ui'],
  css: ['~/assets/css/main.css'],
  // The mark from public/: SVG for the tab, ICO for browsers that only ask for /favicon.ico,
  // and a full-bleed PNG for a phone's home screen (iOS takes no SVG and rounds the corners itself).
  app: {
    head: {
      link: [
        // The ICO first, with its size, so a browser that reads both picks the SVG.
        { rel: 'icon', href: '/favicon.ico', sizes: '32x32' },
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
        { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
      ],
    },
  },
  // Dark by default; the user menu's Appearance changes it.
  colorMode: { preference: 'dark' },
  runtimeConfig: {
    // Set by the compose file's web service at container start, not at build; an
    // empty URL is built in the browser from the page's hostname and the port (lib/urls.ts).
    public: {
      // NUXT_PUBLIC_CONVEX_URL (OMNARR_CONVEX_URL): the backend's client URL.
      convexUrl: '',
      // NUXT_PUBLIC_CONVEX_SITE_URL (OMNARR_CONVEX_SITE_URL): its HTTP actions, where Better Auth runs.
      convexSiteUrl: '',
      // NUXT_PUBLIC_JELLYFIN_PUBLIC_URL (OMNARR_JELLYFIN_URL): Jellyfin as users' devices reach it.
      jellyfinPublicUrl: '',
      // NUXT_PUBLIC_WEB_URL (OMNARR_WEB_URL): only shown on first run's address step; the browser is already on it.
      webUrl: '',
      // NUXT_PUBLIC_WEB_PORT, NUXT_PUBLIC_CONVEX_PORT, NUXT_PUBLIC_CONVEX_SITE_PORT, NUXT_PUBLIC_JELLYFIN_PORT: the published ports.
      webPort: '3000',
      convexPort: '3210',
      convexSitePort: '3211',
      jellyfinPort: '8096',
      // NUXT_PUBLIC_OMNARR_VERSION: the release this build is, set by the release image build; empty in a development build.
      omnarrVersion: '',
    },
  },
  devtools: { enabled: false },
  telemetry: false,
});
