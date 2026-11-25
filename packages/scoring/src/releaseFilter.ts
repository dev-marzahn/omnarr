import { RE2JS, RE2JSException } from 're2js';

export const MAX_RELEASE_FILTER_LENGTH = 500;

const compiled = new Map<string, RE2JS | null>();

function compileInLinearTime(pattern: string): RE2JS | null {
  if (pattern.length > MAX_RELEASE_FILTER_LENGTH) return null;
  try {
    return RE2JS.compile(pattern);
  } catch (error) {
    if (error instanceof RE2JSException) return null;
    throw error;
  }
}

function compiledFilter(pattern: string): RE2JS | null {
  if (!compiled.has(pattern)) compiled.set(pattern, compileInLinearTime(pattern));
  return compiled.get(pattern)!;
}

export const isReadableReleaseFilter = (pattern: string): boolean => compiledFilter(pattern) !== null;

export const releaseFilterMatches = (pattern: string, releaseTitle: string): boolean => compiledFilter(pattern)?.test(releaseTitle) ?? false;
