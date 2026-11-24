import { JellyfinBranding, type OmnarrBrandingClaim } from '@omnarr/contracts';

const OMNARR_LOGO_SVG = [
  `<svg xmlns='http://www.w3.org/2000/svg' width='28' height='28' viewBox='0 0 28 28'>`,
  `<rect x='.5' y='.5' width='27' height='27' rx='7.5' fill='#fff' stroke='#cbd5e1'/>`,
  `<path transform='translate(6 6) scale(.6667)' fill='none' stroke='#0f172a' stroke-linecap='round' stroke-linejoin='round' stroke-width='2'`,
  ` d='M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z'/>`,
  `</svg>`,
].join('');

export const OMNARR_CSS = `:root {
  --omnarr-logo: url("data:image/svg+xml,${encodeURIComponent(OMNARR_LOGO_SVG)}");
  --jf-palette-primary-main: #ffffff;
  --jf-palette-primary-dark: #e2e8f0;
  --jf-palette-primary-contrastText: #0f172a;
  --jf-palette-secondary-main: #ffffff;
  --jf-palette-secondary-contrastText: #0f172a;
}

[data-theme="light"],
[data-theme="appletv"] {
  --jf-palette-primary-main: #0f172a;
  --jf-palette-primary-dark: #1e293b;
  --jf-palette-primary-contrastText: #ffffff;
  --jf-palette-secondary-main: #0f172a;
  --jf-palette-secondary-contrastText: #ffffff;
}

.emby-checkbox:checked + span + .checkboxOutline > .checkboxIcon {
  color: var(--jf-palette-primary-contrastText);
}

html .pageTitleWithDefaultLogo {
  background-image: var(--omnarr-logo);
}

img[src*="icon-transparent"] {
  content: var(--omnarr-logo);
}
`;

const HTML_ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => HTML_ENTITIES[char]!);

const isWebAddress = (url: string) => ['http:', 'https:'].includes(URL.parse(url)?.protocol ?? '');

export function loginDisclaimer(webUrl: string | undefined): string {
  const lead = 'Sign in with your omnarr username and password. To add movies and series, open';
  if (!webUrl || !isWebAddress(webUrl)) return `${lead} omnarr.`;
  return `${lead} <a href="${escapeHtml(webUrl)}" target="_blank" rel="noopener">omnarr</a>.`;
}

export const omnarrBranding = (webUrl: string | undefined): JellyfinBranding => ({
  serverName: 'omnarr',
  loginDisclaimer: loginDisclaimer(webUrl),
  customCss: OMNARR_CSS,
});

export type BrandingPlan = { next: JellyfinBranding; claim: OmnarrBrandingClaim };

export function planBranding(current: JellyfinBranding, wanted: JellyfinBranding, previousClaim: OmnarrBrandingClaim): BrandingPlan {
  const plan: BrandingPlan = { next: { ...current }, claim: {} };
  for (const field of JellyfinBranding.keyof().options) {
    const value = current[field];
    if (value !== wanted[field] && value !== '' && value !== previousClaim[field]) continue;
    plan.next[field] = wanted[field];
    plan.claim[field] = wanted[field];
  }
  return plan;
}
