import { QualityId, ReleaseProfileContent } from '@omnarr/contracts';
import { describe, expect, test } from 'vite-plus/test';

import { SHIPPED_PROFILES } from '../src/index.ts';
import { GROUP_TIERS } from '../src/shipped/groupTiers.ts';
import { anime1080p, uhd2160p, web1080p } from '../src/shipped/v1/index.ts';

const TIER_IDS = ['group.tier1', 'group.tier2', 'group.tier3', 'group.lowQuality', 'anime.tier1', 'anime.tier2', 'anime.tier3'] as const;

describe('the group tiers (transcribed from TRaSH Guides)', () => {
  test('every tier format has names', () => {
    for (const id of TIER_IDS) expect(GROUP_TIERS[id].length, id).toBeGreaterThan(0);
  });

  test('names only: no regex syntax', () => {
    for (const id of TIER_IDS) for (const name of GROUP_TIERS[id]) expect(name, id).toMatch(/^[\w.+\- ]+$/);
  });

  test('each list names a group once, ignoring case', () => {
    for (const id of TIER_IDS) {
      const lower = GROUP_TIERS[id].map((name) => name.toLowerCase());
      expect(new Set(lower).size, id).toBe(lower.length);
    }
  });

  test('a group is in one tier per family, the best it was listed in, and never both low-quality and tiered', () => {
    const families = [
      ['group.tier1', 'group.tier2', 'group.tier3', 'group.lowQuality'],
      ['anime.tier1', 'anime.tier2', 'anime.tier3', 'group.lowQuality'],
    ] as const;
    for (const family of families) {
      const seen = new Map<string, string>();
      for (const id of family) {
        for (const name of GROUP_TIERS[id]) {
          const key = name.toLowerCase();
          expect(seen.get(key), `${name} in ${id}`).toBeUndefined();
          seen.set(key, id);
        }
      }
    }
  });

  test.each([
    ['group.tier1', 'BYNDR', 'Sonarr lists it in WEB Tier 02, Radarr in WEB Tier 01'],
    ['group.tier1', 'HONE', 'WEB Tier 01, and Radarr HD Bluray Tier 03'],
    ['group.tier1', 'D-Z0N3', 'Radarr HD Bluray Tier 01'],
    ['group.tier1', 'PAXA', 'an alternative spelling of APEX'],
    ['group.tier2', 'CEBEX', 'an alternative spelling of XEBEC'],
    ['group.tier2', 'SIGMA', 'Sonarr WEB Tier 02, Radarr WEB Tier 03'],
    ['group.tier3', 'BHDStudio', 'Radarr HD Bluray Tier 03'],
    ['group.lowQuality', 'Pahe.in', 'Pahe with its suffix'],
    ['group.lowQuality', 'YTS.MX', 'YTS with its suffix'],
    ['group.lowQuality', 'NoGrp', 'NoGroup without "ou"'],
    ['anime.tier1', 'Arid', 'Anime Web Tier 01, and BD Tier 02'],
    ['anime.tier2', 'GSK_kun', 'Anime Web Tier 02, and BD Tier 06'],
    ['anime.tier2', 'Okay-Subs', 'Anime BD Tier 03 and Web Tier 02'],
    ['anime.tier3', 'SubsPlease', 'Anime Web Tier 05'],
    ['anime.tier3', 'Iznjie Biznjie', 'Anime BD Tier 04'],
  ] as const)('%s lists %s (%s)', (id, name, _why) => {
    expect(GROUP_TIERS[id].map((n) => n.toLowerCase())).toContain(name.toLowerCase());
  });

  test.each(['Commie', 'Judas', 'Vivid', 'Doki'])('lower anime tiers are not transcribed: %s', (name) => {
    for (const id of TIER_IDS)
      expect(
        GROUP_TIERS[id].map((n) => n.toLowerCase()),
        id,
      ).not.toContain(name.toLowerCase());
  });
});

describe('the shipped profiles (version 2)', () => {
  test('ship web-1080p, uhd-2160p and anime-1080p at version 2', () => {
    expect(Object.keys(SHIPPED_PROFILES).sort()).toEqual(['anime-1080p', 'uhd-2160p', 'web-1080p']);
    for (const shipped of Object.values(SHIPPED_PROFILES)) expect(shipped.version).toBe(2);
  });

  test.each(Object.entries(SHIPPED_PROFILES))('%s prefers full-season packs; version 1 is version 2 without the setting', (key, shipped) => {
    const v1 = { 'web-1080p': web1080p, 'uhd-2160p': uhd2160p, 'anime-1080p': anime1080p }[key]!;
    expect(shipped.content).toEqual({ ...v1, preferSeasonPacks: true });
    expect(v1.preferSeasonPacks).toBeUndefined();
  });

  test.each(Object.entries(SHIPPED_PROFILES))('%s validates against ReleaseProfileContent', (_key, shipped) => {
    expect(ReleaseProfileContent.safeParse(shipped.content).error).toBeUndefined();
  });

  const allowedRanks = (key: keyof typeof SHIPPED_PROFILES) =>
    Object.fromEntries(SHIPPED_PROFILES[key].content.qualities.filter((q) => q.allowed).map((q) => [q.quality, q.rank]));

  test.each([
    ['web-1080p', { 'webdl-1080p': 1, 'bluray-1080p': 2, 'webrip-1080p': 3, 'webdl-720p': 4 }],
    ['uhd-2160p', { 'webdl-2160p': 1, 'bluray-2160p': 2, 'webrip-2160p': 3 }],
    ['anime-1080p', { 'bluray-1080p': 1, 'webdl-1080p': 2, 'webrip-1080p': 2, 'bluray-720p': 3, 'webdl-720p': 4 }],
  ] as const)('%s allows its qualities at their ranks', (key, ranks) => {
    expect(allowedRanks(key)).toEqual(ranks);
  });

  test.each(Object.entries(SHIPPED_PROFILES))('%s ranks the disallowed qualities after every allowed one, in catalogue order', (_key, shipped) => {
    const { qualities } = shipped.content;
    const worstAllowed = Math.max(...qualities.filter((q) => q.allowed).map((q) => q.rank));
    const disallowed = qualities.filter((q) => !q.allowed);
    expect(disallowed.map((q) => q.quality)).toEqual(QualityId.options.filter((id) => disallowed.some((q) => q.quality === id)));
    expect(disallowed.map((q) => q.rank)).toEqual(disallowed.map((_q, i) => worstAllowed + 1 + i));
    expect(qualities.find((q) => q.quality === 'unknown')?.allowed).toBe(false);
  });

  test.each([
    ['web-1080p', '1080p WEB', 'webdl-1080p'],
    ['uhd-2160p', '2160p', 'webdl-2160p'],
    ['anime-1080p', 'Anime 1080p', 'bluray-1080p'],
  ] as const)('%s is named %s, with minimum 0 and cutoff %s at 1500', (key, name, cutoff) => {
    expect(SHIPPED_PROFILES[key].content).toMatchObject({ name, minimumScore: 0, cutoff: { quality: cutoff, score: 1500 } });
  });

  test.each(Object.entries(SHIPPED_PROFILES))('%s has the other shipped fields', (_key, shipped) => {
    const content = shipped.content;
    expect(content.languages).toEqual([{ kind: 'preferred' }, { kind: 'original' }]);
    expect(content.sizeLimits).toEqual([]);
    expect(content.userFormats).toEqual([]);
    expect(content.preferredProtocol).toBeUndefined();
    expect(content.minimumUpgradeStep).toBe(10);
    expect(content.protocols).toEqual(['usenet', 'torrent']);
  });

  const scores = (key: keyof typeof SHIPPED_PROFILES) => Object.fromEntries(SHIPPED_PROFILES[key].content.formatScores.map((f) => [f.formatId, f.score]));
  const web = {
    'group.tier1': 1500,
    'group.tier2': 1000,
    'group.tier3': 500,
    'group.lowQuality': -10000,
    'source.webdl': 50,
    'audio.eac3': 100,
    repack: 5,
    'hdr.dvNoFallback': -10000,
    'prep.video': -10000,
    'prep.remux': 0,
    'prep.audioOrSubtitle': 0,
  };

  test('1080p WEB scores its formats', () => {
    expect(scores('web-1080p')).toEqual(web);
  });

  test('2160p scores as 1080p WEB, plus the HDR formats', () => {
    expect(scores('uhd-2160p')).toEqual({ ...web, 'hdr.dv': 100, 'hdr.hdr10plus': 50, 'hdr.hdr10': 25 });
  });

  test('Anime 1080p scores the anime tiers, 10-bit and multi', () => {
    expect(scores('anime-1080p')).toEqual({
      'anime.tier1': 1500,
      'anime.tier2': 1000,
      'anime.tier3': 500,
      'group.lowQuality': -10000,
      'bitDepth.10': 10,
      'language.multi': 50,
      repack: 5,
      'prep.video': -10000,
      'prep.remux': 0,
      'prep.audioOrSubtitle': 0,
    });
  });

  test.each([
    ['web-1080p', ['group.tier1', 'group.tier2', 'group.tier3', 'group.lowQuality']],
    ['uhd-2160p', ['group.tier1', 'group.tier2', 'group.tier3', 'group.lowQuality']],
    ['anime-1080p', ['anime.tier1', 'anime.tier2', 'anime.tier3', 'group.lowQuality']],
  ] as const)('%s carries the transcribed lists for its tier formats', (key, ids) => {
    expect(SHIPPED_PROFILES[key].content.groupTiers).toEqual(ids.map((formatId) => ({ formatId, groups: [...GROUP_TIERS[formatId]] })));
  });
});
