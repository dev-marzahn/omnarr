import { harbourLightsRestructured, SERIES, type Series } from '@omnarr/e2e/fakes/tmdb/fixtures';
import { describe, expect, test } from 'vite-plus/test';

import { reconcileUnits, type ExistingUnit, type SnapshotUnit } from '../../convex/metadata/reconcile';

const day = 86_400_000;
const D = Date.UTC(2024, 0, 1);

const episode = (tmdbId: string, tmdbSeason: number, tmdbEpisode: number, airDateUtc = D + tmdbEpisode * day): SnapshotUnit => ({
  kind: tmdbSeason === 0 ? 'special' : 'episode',
  tmdbId,
  tmdbSeason,
  tmdbEpisode,
  title: `Episode ${tmdbEpisode}`,
  airDateUtc,
});
const existing = (unitId: string, unit: SnapshotUnit, extra: Partial<ExistingUnit<string>> = {}): ExistingUnit<string> => ({
  unitId,
  tmdbId: unit.tmdbId,
  kind: unit.kind,
  tmdbSeason: unit.tmdbSeason,
  tmdbEpisode: unit.tmdbEpisode,
  airDateUtc: unit.airDateUtc,
  monitored: true,
  retired: false,
  ...extra,
});
const later = { monitorNewUnits: true };

describe('reconcileUnits', () => {
  test('matches a Unit by its TMDB episode ID and updates it; same numbers, no change event', () => {
    const before = episode('e1', 1, 1);
    const after = { ...before, title: 'Pilot' };
    expect(reconcileUnits([existing('u1', before)], [after], later)).toEqual({
      updates: [{ unitId: 'u1', unit: after }],
      unretires: [],
      creates: [],
      retires: [],
    });
  });

  test('a Unit matched by ID keeps its identity when TMDB renumbers it, with the old and new numbers', () => {
    const plan = reconcileUnits([existing('u1', episode('e10', 1, 10))], [episode('e10', 2, 1)], later);
    expect(plan.updates).toEqual([{ unitId: 'u1', unit: episode('e10', 2, 1), change: { from: 'S01E10', to: 'S02E01' } }]);
    expect(plan.creates).toEqual([]);
  });

  test('else matches by number and air date, and adopts the new ID when the old one is gone or missing', () => {
    const plan = reconcileUnits(
      [existing('u1', episode('old', 1, 1)), existing('u2', { ...episode('x', 1, 2), tmdbId: undefined })],
      [episode('new', 1, 1), episode('y', 1, 2)],
      later,
    );
    expect(plan.updates).toEqual([
      { unitId: 'u1', unit: episode('new', 1, 1) },
      { unitId: 'u2', unit: episode('y', 1, 2) },
    ]);
    expect(plan).toMatchObject({ creates: [], retires: [] });
  });

  test('refuses a number match when the air dates differ: the old Unit is retired and a new one created', () => {
    const plan = reconcileUnits([existing('u1', episode('old', 1, 1))], [episode('new', 1, 1, D + 30 * day)], later);
    expect(plan.updates).toEqual([]);
    expect(plan.retires).toEqual([{ unitId: 'u1', change: { from: 'S01E01', to: 'retired' } }]);
    expect(plan.creates).toEqual([{ unit: episode('new', 1, 1, D + 30 * day), monitored: true }]);
  });

  test('does not adopt a number whose old ID TMDB still lists elsewhere', () => {
    const plan = reconcileUnits([existing('u1', episode('a', 1, 1))], [episode('a', 1, 2), episode('b', 1, 1, D + day)], later);
    expect(plan.updates).toEqual([{ unitId: 'u1', unit: episode('a', 1, 2), change: { from: 'S01E01', to: 'S01E02' } }]);
    expect(plan.creates).toEqual([{ unit: episode('b', 1, 1, D + day), monitored: true }]);
  });

  test('on the first write, monitors the seasons asked for and never specials', () => {
    const plan = reconcileUnits([], [episode('s', 0, 1), episode('a', 1, 1), episode('b', 2, 1)], { monitorNewUnits: true, seasons: [0, 2] });
    expect(plan.creates.map((c) => [c.unit.tmdbId, c.monitored])).toEqual([
      ['s', false],
      ['a', false],
      ['b', true],
    ]);
  });

  test('later, a new Unit is monitored if monitorNewUnits is set, it is no special, and its season is new or partly monitored', () => {
    const units = [
      existing('u1', episode('a1', 1, 1), { monitored: false }),
      existing('u2', episode('b1', 2, 1)),
      existing('u3', episode('b2', 2, 2), { monitored: false }),
    ];
    const snapshot = [
      episode('a1', 1, 1),
      episode('a2', 1, 2),
      episode('b1', 2, 1),
      episode('b2', 2, 2),
      episode('b3', 2, 3),
      episode('c1', 3, 1),
      episode('s1', 0, 1),
    ];
    const created = (options: { monitorNewUnits: boolean }) => reconcileUnits(units, snapshot, options).creates.map((c) => [c.unit.tmdbId, c.monitored]);
    expect(created({ monitorNewUnits: true })).toEqual([
      ['a2', false],
      ['b3', true],
      ['c1', true],
      ['s1', false],
    ]);
    expect(created({ monitorNewUnits: false }).every(([, monitored]) => monitored === false)).toBe(true);
  });

  test('retires a Unit TMDB no longer lists, once', () => {
    const plan = reconcileUnits([existing('u1', episode('a', 1, 1)), existing('u2', episode('b', 1, 2), { retired: true, monitored: false })], [], later);
    expect(plan.retires).toEqual([{ unitId: 'u1', change: { from: 'S01E01', to: 'retired' } }]);
  });

  test('un-retires a Unit TMDB lists again', () => {
    const plan = reconcileUnits([existing('u1', episode('a', 1, 3), { retired: true, monitored: false })], [episode('a', 1, 3)], later);
    expect(plan).toEqual({
      updates: [],
      unretires: [{ unitId: 'u1', unit: episode('a', 1, 3), change: { from: 'retired', to: 'S01E03' } }],
      creates: [],
      retires: [],
    });
  });

  test('a movie Work keeps its one Unit', () => {
    const movie: SnapshotUnit = { kind: 'movie', title: 'The Quiet Orchard', airDateUtc: D };
    expect(reconcileUnits([existing('m', movie)], [{ ...movie, airDateUtc: D + day }], later).updates).toEqual([
      { unitId: 'm', unit: { ...movie, airDateUtc: D + day } },
    ]);
    expect(reconcileUnits([], [movie], { monitorNewUnits: true, seasons: [] }).creates).toEqual([{ unit: movie, monitored: true }]);
  });

  test('a season restructure moves Units by their IDs and retires the deleted placeholder', () => {
    const units = (series: Series) =>
      series.seasons.flatMap((s) => s.episodes.map((e) => episode(String(e.id), e.season_number, e.episode_number, Date.parse(`${e.air_date}T00:00:00Z`))));
    const before = units(SERIES[0]!).map((unit, i) => existing(`u${i}`, unit));
    const plan = reconcileUnits(before, units(harbourLightsRestructured()), later);
    const byId = (id: number) => before.find((u) => u.tmdbId === String(id))!.unitId;
    expect(plan.creates).toEqual([]);
    expect(plan.retires).toEqual([{ unitId: byId(910205), change: { from: 'S02E06', to: 'retired' } }]);
    expect(plan.updates.filter((u) => u.change).map((u) => [u.unitId, u.change!.from, u.change!.to])).toEqual([
      [byId(910103), 'S01E04', 'S02E01'],
      [byId(910104), 'S01E05', 'S02E02'],
      [byId(910105), 'S01E06', 'S02E03'],
      ...[1, 2, 3, 4, 5].map((e) => [byId(910200 + e - 1), `S02E0${e}`, `S03E0${e}`]),
    ]);
  });
});
