// What re-posters and indexers append to a release name (the clean-up pass).
// Each is matched at the end of the name, ignoring case, any number of times.
export const REPOST_SUFFIXES: readonly string[] = ['-Obfuscated', '-postbot', '[eztv]', '[rartv]', '-Scrambled', '-xpost'];
