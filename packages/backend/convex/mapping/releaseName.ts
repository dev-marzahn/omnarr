const MAX_TITLE = 200;

const CONTROL = /[\p{Cc}\p{Cf}]/u;

export function releaseName(raw: string): string | undefined {
  const title = raw.trim();
  return title && title.length <= MAX_TITLE && !CONTROL.test(title) ? title : undefined;
}
