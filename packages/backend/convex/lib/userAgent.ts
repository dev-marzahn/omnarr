/** The User-Agent outside services see (Nyaa, Sonarr's scene mappings): the deployment's release, as the System page names it. */
export const userAgent = () => `omnarr/${process.env.CONVEX_RELEASE_VERSION || '0.0.0-dev'}`;
