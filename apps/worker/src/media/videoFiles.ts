// Which files are videos, and which a listing skips: the import's rules
//, which the untracked-media scan shares.
import { extname } from 'node:path';

const VIDEO = new Set(['.mkv', '.mp4', '.m4v', '.avi', '.ts', '.m2ts', '.webm', '.mov', '.wmv']);
/** Jellyfin's extras folders: their videos are never the episode or the film. */
const EXTRAS_FOLDERS = new Set(['extras', 'featurettes', 'behind the scenes', 'deleted scenes', 'interviews', 'scenes', 'shorts', 'trailers', 'other']);
/** What qBittorrent and other clients add to a file they are still writing. */
const UNFINISHED = /\.(partial|!qb)$/i;
const SAMPLE = /\bsamples?\b/i;

/** Whether a file name is a finished video: a video extension, not `.partial` or `.!qB`. */
export const isFinishedVideo = (name: string): boolean => !UNFINISHED.test(name) && VIDEO.has(extname(name).toLowerCase());

/** Whether a folder is one of Jellyfin's extras folders. */
export const isExtrasFolder = (name: string): boolean => EXTRAS_FOLDERS.has(name.toLowerCase());

/** Whether a file or folder name marks a sample. */
export const isSample = (name: string): boolean => SAMPLE.test(name);
