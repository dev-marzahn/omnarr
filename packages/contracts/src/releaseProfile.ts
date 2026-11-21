// Release profiles: their editable content, user formats and
// the profile DTOs.
import { zid } from 'convex-helpers/server/zod4';
import { z } from 'zod';

import { DownloadProtocol } from './indexer.ts';
import { EDITION_FLAGS, LanguageCode, QualityId } from './release.ts';

/** One entry of a profile's language list, which is OR. */
export const LanguageSpec = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('code'), code: LanguageCode }),
  // The Work's original language (`workMetadata.originalLanguage`).
  z.object({ kind: z.literal('original') }),
  // The language subtag of `metadataSettings.language`.
  z.object({ kind: z.literal('preferred') }),
]);
export type LanguageSpec = z.infer<typeof LanguageSpec>;

const editionFields = EDITION_FLAGS.map((flag) => `edition.${flag}` as const);

/** A user format's condition on one parser field. There is no title regex. */
export const Condition = z.union([
  z
    .object({
      field: z.enum(['source', 'videoCodec', 'audioCodec', 'audioChannels', 'streamingService', 'group', 'modifier', 'container']),
      op: z.enum(['in', 'notIn']),
      values: z.array(z.string()),
    })
    .strict(),
  z.object({ field: z.enum(['resolution', 'bitDepth']), op: z.enum(['in', 'notIn', 'gte', 'lte']), values: z.array(z.number()) }).strict(),
  z.object({ field: z.enum(['hdr', 'languages', 'subtitleLanguages']), op: z.enum(['any', 'all', 'none']), values: z.array(z.string()) }).strict(),
  z.object({ field: z.enum(['atmos', 'hardcodedSubs', 'repack', ...editionFields]), op: z.literal('is'), value: z.boolean() }).strict(),
]);
export type Condition = z.infer<typeof Condition>;

/** All of `all`, at least one of `any`, none of `none`. At least one condition in total. */
export const FormatRule = z
  .object({ all: z.array(Condition).optional(), any: z.array(Condition).optional(), none: z.array(Condition).optional() })
  .strict()
  .refine((rule) => (rule.all?.length ?? 0) + (rule.any?.length ?? 0) + (rule.none?.length ?? 0) > 0, 'A format needs at least one condition.');
export type FormatRule = z.infer<typeof FormatRule>;

export const UserFormat = z.object({ id: z.string(), name: z.string().min(1), rule: FormatRule, score: z.number() });
export type UserFormat = z.infer<typeof UserFormat>;

/** Equal `rank` means equal preference; rank 1 is the best. */
export const QualityEntry = z.object({ quality: QualityId, allowed: z.boolean(), rank: z.number().int().min(1) });
export type QualityEntry = z.infer<typeof QualityEntry>;

/** Megabytes per minute of the summed runtime of the Units a release covers. */
export const SizeLimit = z.object({ quality: QualityId, minMbPerMin: z.number().optional(), maxMbPerMin: z.number().optional() });
export type SizeLimit = z.infer<typeof SizeLimit>;

/** The group names a tier format matches, case-insensitively. */
export const GroupTier = z.object({ formatId: z.string(), groups: z.array(z.string()) });
export type GroupTier = z.infer<typeof GroupTier>;

export const FormatScore = z.object({ formatId: z.string(), score: z.number() });
export type FormatScore = z.infer<typeof FormatScore>;

/** Every field the user can edit, and what a shipped version freezes. */
export const ReleaseProfileContent = z.object({
  name: z.string().min(1),
  qualities: z.array(QualityEntry).refine((entries) => {
    const listed = entries.map((entry) => entry.quality);
    return listed.length === QualityId.options.length && new Set(listed).size === listed.length;
  }, 'Every quality must appear exactly once.'),
  minimumScore: z.number(),
  cutoff: z.object({ quality: QualityId, score: z.number() }),
  minimumUpgradeStep: z.number(),
  languages: z.array(LanguageSpec),
  formatScores: z.array(FormatScore),
  userFormats: z.array(UserFormat),
  groupTiers: z.array(GroupTier),
  sizeLimits: z.array(SizeLimit),
  protocols: z.array(DownloadProtocol),
  preferredProtocol: DownloadProtocol.optional(),
  /**
   * In a season group's pick, a full-season pack the profile accepts wins
   * when its preparation and quality are no worse than the best other
   * candidate's. True from shipped version 2; absent, as on content from
   * version 1, it is off.
   */
  preferSeasonPacks: z.boolean().optional(),
});
export type ReleaseProfileContent = z.infer<typeof ReleaseProfileContent>;

export const ReleaseProfile = ReleaseProfileContent.extend({
  shippedKey: z.string().optional(),
  shippedVersion: z.number().optional(),
  pendingShippedVersion: z.number().optional(),
  editedByUser: z.boolean(),
});
export type ReleaseProfile = z.infer<typeof ReleaseProfile>;

/** A row of the profile list. */
export const ReleaseProfileSummary = z
  .object({
    id: zid('releaseProfiles'),
    name: z.string(),
    shippedKey: z.string().optional(),
    edited: z.boolean(),
    updateAvailable: z.boolean(),
    /** Libraries that default to it plus Works that use it. */
    usedBy: z.number(),
  })
  .strict();
export type ReleaseProfileSummary = z.infer<typeof ReleaseProfileSummary>;

/** The profile editor. */
export const ReleaseProfileDetail = z
  .object({
    id: zid('releaseProfiles'),
    profile: ReleaseProfile,
    usedBy: z.object({
      libraries: z.array(z.object({ libraryId: zid('libraries'), name: z.string() })),
      works: z.array(z.object({ workId: zid('works'), title: z.string() })),
    }),
    formatCatalogue: z.array(z.object({ id: z.string(), name: z.string(), kind: z.enum(['format', 'preparation']) })),
    pendingShippedVersion: z.number().optional(),
    targetWarnings: z.array(z.object({ libraryId: zid('libraries'), message: z.string() })),
  })
  .strict();
export type ReleaseProfileDetail = z.infer<typeof ReleaseProfileDetail>;
