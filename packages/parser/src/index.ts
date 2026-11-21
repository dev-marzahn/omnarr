// The release-title parser: `parseRelease` and the normalization rules.
export { compactTitle, normalizeReleaseTitle, normalizeTitle, titleSides } from './normalize.ts';
export { parseRelease } from './wrap.ts';
/** The services the parser reads; scoring has one `streaming.<service>` format per entry. */
export { STREAMING_SERVICES } from './tables/streamingServices.ts';
