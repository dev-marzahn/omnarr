// Site definitions: what the support check decides, what the
// catalogue lists, a definition indexer's settings, and the sync's status.
import { zid } from 'convex-helpers/server/zod4';
import { z } from 'zod';

import type { IndexerCaps } from './indexer.ts';

/** Why a definition is unsupported. */
export const DefinitionSupportReason = z.enum([
  'needsFlareSolverr',
  'captcha',
  'privateInP2',
  'loginMethod',
  'unknownFilter',
  'unknownKey',
  'templateConstruct',
  'regex',
  'dateLayout',
  'selector',
  'unsupportedFeature',
  'tooLarge',
  'invalidYaml',
  'builtIn',
  'replacedUpstream',
]);
export type DefinitionSupportReason = z.infer<typeof DefinitionSupportReason>;

/** `detail` names what failed (the filter, key, pattern and where); never site text. */
export const DefinitionSupport = z.union([
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), reason: DefinitionSupportReason, detail: z.string().optional() }).strict(),
]);
export type DefinitionSupport = z.infer<typeof DefinitionSupport>;

export const DefinitionType = z.enum(['public', 'semi-private', 'private']);
export type DefinitionType = z.infer<typeof DefinitionType>;

/** One of a definition's settings, for the form. `info*` types are text to show. */
export const DefinitionSetting = z
  .object({
    name: z.string(),
    type: z.string(),
    label: z.string().optional(),
    default: z.union([z.string(), z.boolean()]).optional(),
    /** A select's options, value → label, in the file's order. */
    options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  })
  .strict();
export type DefinitionSetting = z.infer<typeof DefinitionSetting>;

/** What the catalogue and the settings form need of a definition. */
export const DefinitionMeta = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    type: DefinitionType,
    language: z.string().optional(),
    links: z.array(z.string()),
    legacylinks: z.array(z.string()).optional(),
    settings: z.array(DefinitionSetting),
    /** The search modes the caps name, with their parameters. */
    modes: z.record(z.string(), z.array(z.string())),
    /** The Newznab categories the mappings name, deduplicated. */
    categories: z.array(z.number()),
    /** Seconds, when the file sets one. */
    requestDelay: z.number().optional(),
  })
  .strict();
export type DefinitionMeta = z.infer<typeof DefinitionMeta>;

export const DefinitionSource = z.enum(['upstream', 'custom']);
export type DefinitionSource = z.infer<typeof DefinitionSource>;

/** A newer upstream file that fails the check while the stored one passes. */
export const PendingUpdate = z.object({ sha256: z.string(), reason: DefinitionSupportReason, detail: z.string().optional() }).strict();
export type PendingUpdate = z.infer<typeof PendingUpdate>;

/** One definition as the sync writes it (`definitions.upsertBatch`). `meta` is absent when the file couldn't be read. */
export const SiteDefinitionUpsert = z
  .object({
    definitionId: z.string(),
    source: DefinitionSource,
    sha256: z.string(),
    yaml: z.string(),
    meta: DefinitionMeta.optional(),
    support: DefinitionSupport,
  })
  .strict();
export type SiteDefinitionUpsert = z.infer<typeof SiteDefinitionUpsert>;

/** A catalogue row: every definition, unsupported ones with their reason. */
export const SiteDefinitionRow = z
  .object({
    definitionId: z.string(),
    source: DefinitionSource,
    name: z.string(),
    description: z.string().optional(),
    type: DefinitionType,
    language: z.string().optional(),
    support: DefinitionSupport,
    pendingUpdate: PendingUpdate.optional(),
    removedUpstream: z.boolean().optional(),
  })
  .strict();
export type SiteDefinitionRow = z.infer<typeof SiteDefinitionRow>;

/** One definition for the settings form: the row plus its links and settings. */
export const SiteDefinitionDetail = SiteDefinitionRow.extend({ meta: DefinitionMeta }).strict();
export type SiteDefinitionDetail = z.infer<typeof SiteDefinitionDetail>;

/** A definition indexer's setting values, by name. `text` and `password` values are internal. */
export const SiteSettings = z.record(z.string(), z.union([z.string(), z.boolean()]));
export type SiteSettings = z.infer<typeof SiteSettings>;

/** `indexers.site`. */
export const IndexerSite = z
  .object({
    definitionId: z.string(),
    baseUrl: z.string(),
    settings: SiteSettings,
    /** The definition's name and `requestDelay`, copied at create and at each sync that changes the file, for the row and the pacing slot. */
    definitionName: z.string(),
    requestDelayMs: z.number().optional(),
  })
  .strict();
export type IndexerSite = z.infer<typeof IndexerSite>;

export const DefinitionSyncFailure = z.enum(['definitionSyncFailed']);

/** The last sync (`definitionSync`), as the System page's card shows it. */
export const DefinitionSyncStatus = z
  .object({
    at: z.number(),
    ok: z.boolean(),
    /** The host the package came from. */
    source: z.string(),
    failure: z.object({ code: DefinitionSyncFailure, detail: z.string() }).strict().optional(),
    supported: z.number(),
    unsupported: z.number(),
    pending: z.number(),
  })
  .strict();
export type DefinitionSyncStatus = z.infer<typeof DefinitionSyncStatus>;

// The site definition worker functions: the engine's pacing slot,
// a definition indexer's config (with its secrets: the second worker function
// after `jellyfin.setup.connection` that returns any), and the sync's writes.
// Each is fenced on the lease of the job it serves, and the backend checks
// that the job names the indexer or definition (protocol.ts' Lease, inline:
// protocol.ts imports this module through jobs.ts).
const JobLease = { jobId: zid('jobs'), leaseEpoch: z.number() };

/** `worker.reservePacing`: the indexer's next slot. The backend computes the interval from the definition. */
export const ReservePacingRequest = z.object({ ...JobLease, indexerId: zid('indexers') }).strict();
export type ReservePacingRequest = z.infer<typeof ReservePacingRequest>;
export const ReservePacingResponse = z.union([z.object({ waitMs: z.number() }).strict(), z.object({ skip: z.literal(true) }).strict()]);
export type ReservePacingResponse = z.infer<typeof ReservePacingResponse>;

/** `sites.config`: what the engine needs to run one indexer. Internal: `settings` holds text and password values. */
export const SiteConfigRequest = z.object({ ...JobLease, indexerId: zid('indexers') }).strict();

/** A definition's file, for a `testDraft` job: the indexer isn't saved yet. */
export const DefinitionFileRequest = z.object({ ...JobLease, definitionId: z.string() }).strict();
export type DefinitionFileRequest = z.infer<typeof DefinitionFileRequest>;
export const DefinitionFile = z.object({ name: z.string(), sha256: z.string(), yaml: z.string() }).strict();
export type DefinitionFile = z.infer<typeof DefinitionFile>;
export type SiteConfigRequest = z.infer<typeof SiteConfigRequest>;
export const SiteConfig = z
  .object({
    indexerId: zid('indexers'),
    name: z.string(),
    definitionId: z.string(),
    sha256: z.string(),
    yaml: z.string(),
    baseUrl: z.string(),
    settings: SiteSettings,
  })
  .strict();
export type SiteConfig = z.infer<typeof SiteConfig>;

/** The sync writes at most this many definitions per mutation. */
export const DEFINITION_BATCH_SIZE = 50;

export const UpsertDefinitionsRequest = z
  .object({ ...JobLease, syncedAt: z.number(), rows: z.array(SiteDefinitionUpsert).max(DEFINITION_BATCH_SIZE) })
  .strict();
export type UpsertDefinitionsRequest = z.infer<typeof UpsertDefinitionsRequest>;

/**
 * The sync's end: its status, and on success every id it found, so the ids it
 * no longer found are marked `removedUpstream`. A failed sync sends no ids and
 * changes no row.
 */
export const FinishDefinitionSyncRequest = z
  .object({
    ...JobLease,
    /** The counts are the backend's, over the stored rows. */
    status: DefinitionSyncStatus.omit({ supported: true, unsupported: true, pending: true }),
    seenIds: z.array(z.string()).optional(),
  })
  .strict();
export type FinishDefinitionSyncRequest = z.infer<typeof FinishDefinitionSyncRequest>;
export const FinishDefinitionSyncResponse = DefinitionSyncStatus.pick({ supported: true, unsupported: true, pending: true });
export type FinishDefinitionSyncResponse = z.infer<typeof FinishDefinitionSyncResponse>;

/** The definitions server's schema version Prowlarr asks for; the server falls back to v11 files. */
export const DEFINITION_VERSION = 12;
export const DEFAULT_DEFINITIONS_URL = 'https://indexers.prowlarr.com/master';

/** Definition ids omnarr lists but never runs: Nyaa is built in. */
export const BUILT_IN_DEFINITIONS = ['nyaasi'] as const;
/** The ids Prowlarr hides because its own C# replaced them. */
export const REPLACED_UPSTREAM_DEFINITIONS = [
  'aither',
  'animeworld',
  'audiobookbay',
  'beyond-hd-oneurl',
  'beyond-hd',
  'blutopia',
  'brsociety',
  'danishbytes',
  'datascene',
  'desitorrents',
  'hdbits',
  'lat-team',
  'mteamtp',
  'mteamtp2fa',
  'reelflix',
  'shareisland',
  'skipthecommercials',
  'tellytorrent',
] as const;

// Newznab's standard categories, for a definition's caps: a
// definition's `cat: TV/Anime` is 5070. The table follows the Newznab category
// list; an unknown name maps to nothing, as Prowlarr skips it.
const NEWZNAB_GROUPS: [number, string, [number, string][]][] = [
  [
    1000,
    'Console',
    [
      [1010, 'NDS'],
      [1020, 'PSP'],
      [1030, 'Wii'],
      [1040, 'XBox'],
      [1050, 'XBox 360'],
      [1060, 'Wiiware'],
      [1070, 'XBox 360 DLC'],
      [1080, 'PS3'],
      [1090, 'Other'],
      [1110, '3DS'],
      [1120, 'PS Vita'],
      [1130, 'WiiU'],
      [1140, 'XBox One'],
      [1180, 'PS4'],
    ],
  ],
  [
    2000,
    'Movies',
    [
      [2010, 'Foreign'],
      [2020, 'Other'],
      [2030, 'SD'],
      [2040, 'HD'],
      [2045, 'UHD'],
      [2050, 'BluRay'],
      [2060, '3D'],
      [2070, 'DVD'],
      [2080, 'WEB-DL'],
      [2090, 'x265'],
    ],
  ],
  [
    3000,
    'Audio',
    [
      [3010, 'MP3'],
      [3020, 'Video'],
      [3030, 'Audiobook'],
      [3040, 'Lossless'],
      [3050, 'Other'],
      [3060, 'Foreign'],
    ],
  ],
  [
    4000,
    'PC',
    [
      [4010, '0day'],
      [4020, 'ISO'],
      [4030, 'Mac'],
      [4040, 'Mobile-Other'],
      [4050, 'Games'],
      [4060, 'Mobile-iOS'],
      [4070, 'Mobile-Android'],
    ],
  ],
  [
    5000,
    'TV',
    [
      [5010, 'WEB-DL'],
      [5020, 'Foreign'],
      [5030, 'SD'],
      [5040, 'HD'],
      [5045, 'UHD'],
      [5050, 'Other'],
      [5060, 'Sport'],
      [5070, 'Anime'],
      [5080, 'Documentary'],
      [5090, 'x265'],
    ],
  ],
  [
    6000,
    'XXX',
    [
      [6010, 'DVD'],
      [6020, 'WMV'],
      [6030, 'XviD'],
      [6040, 'x264'],
      [6045, 'UHD'],
      [6050, 'Pack'],
      [6060, 'ImageSet'],
      [6070, 'Other'],
      [6080, 'SD'],
      [6090, 'WEB-DL'],
    ],
  ],
  [
    7000,
    'Books',
    [
      [7010, 'Mags'],
      [7020, 'EBook'],
      [7030, 'Comics'],
      [7040, 'Technical'],
      [7050, 'Other'],
      [7060, 'Foreign'],
    ],
  ],
  [
    8000,
    'Other',
    [
      [8010, 'Misc'],
      [8020, 'Hashed'],
    ],
  ],
];

const NEWZNAB_NAMES = new Map<number, string>();
const NEWZNAB_IDS = new Map<string, number>();
for (const [id, name, children] of NEWZNAB_GROUPS) {
  NEWZNAB_NAMES.set(id, name);
  NEWZNAB_IDS.set(name.toLowerCase(), id);
  for (const [childId, childName] of children) {
    NEWZNAB_NAMES.set(childId, `${name}/${childName}`);
    NEWZNAB_IDS.set(`${name}/${childName}`.toLowerCase(), childId);
  }
}

/** A Newznab category name's id, ignoring case; undefined for a name outside the standard list. */
export const newznabCategoryId = (name: string | undefined): number | undefined =>
  name === undefined ? undefined : NEWZNAB_IDS.get(name.trim().toLowerCase());
export const newznabParentOf = (id: number): number => Math.floor(id / 1000) * 1000;

/**
 * A definition's caps: its modes as the indexer search modes with their
 * parameters (other modes dropped), its categories with their parents, and
 * no page size.
 */
export function capsFromMeta(meta: Pick<DefinitionMeta, 'modes' | 'categories'>, now: number): IndexerCaps {
  const searchModes = (['search', 'tv-search', 'movie-search'] as const).map((mode) => {
    const params = meta.modes[mode];
    return { mode, available: params !== undefined, supportedParams: params ?? [] };
  });
  const ids = new Set<number>();
  for (const id of meta.categories) {
    if (!NEWZNAB_NAMES.has(id)) continue;
    ids.add(id);
    ids.add(newznabParentOf(id));
  }
  const categories = [...ids]
    .sort((a, b) => a - b)
    .map((id) => ({ id, name: NEWZNAB_NAMES.get(id)!, ...(id % 1000 ? { parentId: newznabParentOf(id) } : {}) }));
  return { searchModes, pageLimit: {}, categories, fetchedAt: now };
}

/** A definition indexer's minimum interval: max(2 s, requestDelay). */
export const definitionIntervalMs = (requestDelaySec: number | undefined, minMs: number) => Math.max(minMs, Math.round((requestDelaySec ?? 0) * 1000));
