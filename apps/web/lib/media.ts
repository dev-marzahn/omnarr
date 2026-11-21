// Stored images and other files come from the Convex backend's
// file storage, on the backend's origin, not the web app's: a relative path
// or the backend's loopback origin becomes the Convex URL (lib/urls.ts).
import { rewriteStorageUrl } from './urls';

export function mediaUrl(src: string | undefined, convexUrl: string): string | undefined {
  return src ? rewriteStorageUrl(src, convexUrl) : undefined;
}
