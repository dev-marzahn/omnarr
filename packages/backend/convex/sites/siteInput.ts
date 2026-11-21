// A definition indexer's form values: the base URL must be one
// of the definition's links, and each setting one of its settable settings
// with a value of its type. On update, an empty text or password value keeps
// the stored one, as an empty API key does.
import type { DefinitionMeta, SiteSettings } from '@omnarr/contracts';
import { ConvexError } from 'convex/values';

const SETTABLE = new Set(['text', 'password', 'checkbox', 'select']);
const SECRET = new Set(['text', 'password']);

export function siteValues(
  meta: DefinitionMeta,
  input: { baseUrl?: string; settings?: SiteSettings },
  stored?: { baseUrl: string; settings: SiteSettings },
): { baseUrl: string; settings: SiteSettings } {
  const baseUrl = input.baseUrl ?? stored?.baseUrl ?? meta.links[0]!;
  const legacy = stored?.baseUrl === baseUrl && (meta.legacylinks ?? []).includes(baseUrl);
  if (!meta.links.includes(baseUrl) && !legacy) throw new ConvexError({ code: 'invalidBaseUrl' });
  const settings: SiteSettings = { ...stored?.settings };
  for (const [name, value] of Object.entries(input.settings ?? {})) {
    const setting = meta.settings.find((candidate) => candidate.name === name);
    if (!setting || !SETTABLE.has(setting.type)) throw new ConvexError({ code: 'invalidSettings', setting: name });
    if (setting.type === 'checkbox') {
      if (typeof value !== 'boolean') throw new ConvexError({ code: 'invalidSettings', setting: name });
    } else if (typeof value !== 'string') throw new ConvexError({ code: 'invalidSettings', setting: name });
    if (setting.type === 'select' && !(setting.options ?? []).some((option) => option.value === value))
      throw new ConvexError({ code: 'invalidSettings', setting: name });
    if (SECRET.has(setting.type) && value === '' && stored && stored.settings[name] !== undefined) continue;
    settings[name] = value;
  }
  return { baseUrl, settings };
}
