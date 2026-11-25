const MAX_LIST_BYTES = 16 * 1024 * 1024;

export type CappedFetch = { label: string; timeoutMs: number; maxBytes?: number; headers?: Record<string, string> };

export type IfChanged = { notModified: true } | { notModified: false; body: string; etag?: string };

const unreachable = (label: string) => new Error(`${label} could not be reached.`);
const answered = (label: string, status: number) => new Error(`${label} answered ${status}.`);
const tooLarge = (label: string) => new Error(`${label} is too large.`);

async function withDeadline<T>(timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function get(url: string, { label, headers }: CappedFetch, signal: AbortSignal): Promise<Response> {
  try {
    return await fetch(url, { headers, signal });
  } catch {
    throw unreachable(label);
  }
}

async function readCapped(response: Response, { label, maxBytes = MAX_LIST_BYTES }: CappedFetch): Promise<string> {
  if (Number(response.headers.get('content-length') ?? 0) > maxBytes) throw tooLarge(label);
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  for (;;) {
    const chunk = await reader.read().catch(() => {
      throw unreachable(label);
    });
    if (chunk.done) return text + decoder.decode();
    bytes += chunk.value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw tooLarge(label);
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
}

export function fetchCappedText(url: string, options: CappedFetch): Promise<string> {
  return withDeadline(options.timeoutMs, async (signal) => {
    const response = await get(url, options, signal);
    if (!response.ok) throw answered(options.label, response.status);
    return readCapped(response, options);
  });
}

export function fetchCappedTextIfChanged(url: string, etag: string | undefined, options: CappedFetch): Promise<IfChanged> {
  return withDeadline(options.timeoutMs, async (signal) => {
    const conditional = { ...options, headers: { ...options.headers, ...(etag ? { 'if-none-match': etag } : {}) } };
    const response = await get(url, conditional, signal);
    if (etag && response.status === 304) return { notModified: true };
    if (!response.ok) throw answered(options.label, response.status);
    return { notModified: false, body: await readCapped(response, options), etag: response.headers.get('etag') ?? undefined };
  });
}
