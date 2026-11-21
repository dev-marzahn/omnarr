// The playback-profile page's wording and draft logic.
import { type ChangePreview, type DeviceCard, type PlaybackProfileDetail, targetForDevices } from '@omnarr/contracts';
import { describe, expect, test } from 'vite-plus/test';

import {
  BIT_DEPTH_ITEMS,
  CHANNEL_ITEMS,
  HDR_ITEMS,
  HEIGHT_ITEMS,
  optionItems,
  capField,
  capKey,
  capOverride,
  changeLine,
  changesNoFile,
  codecLabel,
  deviceLines,
  draftOf,
  draftTarget,
  editDirectly,
  KEEP_ORIGINAL,
  resetToDevices,
  saveDialog,
  savedToast,
  setFirst,
  setIncluded,
  stepLabel,
  subtitleModeItems,
  targetProblems,
  targetRows,
  toggleDevice,
} from '../lib/playback';

describe('labels', () => {
  test.each([
    ['video', 'Video transcode'],
    ['audio', 'Audio conversion'],
    ['subtitle', 'Subtitle conversion'],
    ['remux', 'Remux'],
  ] as const)('the %s step reads "%s"', (step, label) => {
    expect(stepLabel(step)).toBe(label);
  });

  test.each([
    ['h264', 'H.264'],
    ['hevc', 'HEVC'],
    ['av1', 'AV1'],
    ['aac', 'AAC'],
    ['ac3', 'AC-3'],
    ['eac3', 'E-AC-3'],
    ['opus', 'Opus'],
    ['flac', 'FLAC'],
    ['mp3', 'MP3'],
    ['truehd', 'TrueHD'],
    ['mp4', 'MP4'],
    ['mkv', 'MKV'],
    ['matroska', 'Matroska'],
    ['subrip', 'SubRip'],
    ['ass', 'ASS'],
    ['hdmv_pgs_subtitle', 'PGS'],
    ['dvd_subtitle', 'VobSub'],
  ])('the codec %s reads "%s"', (codec, label) => {
    expect(codecLabel(codec)).toBe(label);
  });

  test('a codec without a label keeps its ffprobe name', () => {
    expect(codecLabel('prores')).toBe('prores');
  });
});

// In devices mode the cap is the user's override, "No cap" (null), or the devices' own (absent).
describe('the resolution cap field', () => {
  test('its placeholder is the cap the ticked devices give', () => {
    expect(capField(1080).placeholder).toBe('1080p, from the devices');
    expect(capField(null).placeholder).toBe('No cap, from the devices');
  });

  test('its items: back to the devices, no cap, then the heights', () => {
    expect(capField(1080).items).toEqual([
      { value: 'derived', label: 'From the devices (1080p)' },
      { value: 'none', label: 'No cap' },
      { value: '2160', label: '2160p' },
      { value: '1440', label: '1440p' },
      { value: '1080', label: '1080p' },
      { value: '720', label: '720p' },
      { value: '480', label: '480p' },
    ]);
  });

  test('the override shows as an item key, the derived cap as the placeholder', () => {
    expect(capKey(undefined)).toBeUndefined();
    expect(capKey(null)).toBe('none');
    expect(capKey(720)).toBe('720');
  });

  test('a picked item becomes the override', () => {
    expect(capOverride('derived')).toBeUndefined();
    expect(capOverride('none')).toBeNull();
    expect(capOverride('2160')).toBe(2160);
  });
});

// previewChange's counts, by most expensive step, with the scanned files that stay on demand.
describe('the save dialog', () => {
  const preview = (overrides: Partial<ChangePreview> = {}): ChangePreview => ({
    noLongerFit: { remux: 96, audio: 38, subtitle: 0, video: 8 },
    willPrepare: 140,
    scannedOnDemand: 2,
    nowFit: 0,
    truncated: false,
    ...overrides,
  });

  test('files that stop fitting, by their most expensive step, cheapest first', () => {
    expect(saveDialog(preview(), 'Series')).toEqual({
      title: 'Save the Series playback profile?',
      headline: '142 files no longer fit',
      steps: [
        { label: 'Remux only', value: '96 files · fast' },
        { label: 'Audio conversion', value: '38 files' },
        { label: 'Video transcode', value: '8 files · slow, CPU' },
      ],
      lines: [
        'They stay playable as Not yet in target format.',
        '140 files are prepared automatically, one at a time.',
        '2 scanned files stay as they are until you prepare them.',
      ],
      help: "Preparing runs in its own queue, so downloads and imports aren't held up.",
      confirm: 'Save and prepare',
    });
  });

  test('one file of each, and files that now fit', () => {
    const dialog = saveDialog(preview({ noLongerFit: { remux: 0, audio: 0, subtitle: 1, video: 0 }, willPrepare: 0, scannedOnDemand: 1, nowFit: 1 }), 'Movies');
    expect(dialog.headline).toBe('1 file no longer fits');
    expect(dialog.steps).toEqual([{ label: 'Subtitle conversion', value: '1 file' }]);
    expect(dialog.lines).toEqual(['It stays playable as Not yet in target format.', '1 scanned file stays as it is until you prepare it.', '1 file now fits.']);
    expect(dialog.help).toBeUndefined();
    expect(dialog.confirm).toBe('Save');
  });

  test('only files that now fit', () => {
    const dialog = saveDialog(
      preview({ noLongerFit: { remux: 0, audio: 0, subtitle: 0, video: 0 }, willPrepare: 0, scannedOnDemand: 0, nowFit: 1200 }),
      'Series',
    );
    expect(dialog.headline).toBeUndefined();
    expect(dialog.lines).toEqual(['1,200 files now fit.']);
  });

  test('past 4,000 files the counts are lower bounds: "4,000+"', () => {
    const dialog = saveDialog(
      preview({ noLongerFit: { remux: 3000, audio: 1000, subtitle: 0, video: 0 }, willPrepare: 4000, scannedOnDemand: 0, truncated: true }),
      'Series',
    );
    expect(dialog.headline).toBe('4,000+ files no longer fit');
    expect(dialog.steps).toEqual([
      { label: 'Remux only', value: '3,000+ files · fast' },
      { label: 'Audio conversion', value: '1,000+ files' },
    ]);
    expect(dialog.lines).toEqual(['They stay playable as Not yet in target format.', '4,000+ files are prepared automatically, one at a time.']);
    expect(dialog.note).toBe('The library has more than 4,000 files; these counts are from the first 4,000.');
  });

  test('a save that changes no file skips the dialog and says so', () => {
    const none = preview({ noLongerFit: { remux: 0, audio: 0, subtitle: 0, video: 0 }, willPrepare: 0, scannedOnDemand: 0, nowFit: 0 });
    expect(changesNoFile(none)).toBe(true);
    expect(changesNoFile(preview())).toBe(false);
    expect(changesNoFile({ ...none, truncated: true })).toBe(false);
    expect(savedToast('Series')).toEqual({ title: 'Saved', description: 'Every file in Series still fits.' });
  });
});

describe('the device cards', () => {
  const chrome: DeviceCard = {
    deviceId: 'chrome',
    name: 'Chrome',
    subtitle: 'Jellyfin web',
    containers: ['mp4'],
    videoCodecs: ['h264 8-bit', 'av1 10-bit'],
    maxHeight: null,
    audioCodecs: ['aac', 'mp3', 'opus', 'flac'],
    maxChannels: 2,
  };

  test("a card's lines: what the device plays directly", () => {
    expect(deviceLines(chrome)).toEqual(['MP4 · H.264 8-bit, AV1 10-bit · any resolution', 'AAC, MP3, Opus, FLAC · up to 2.0']);
    expect(deviceLines({ ...chrome, maxHeight: 1080, maxChannels: 6 })).toEqual([
      'MP4 · H.264 8-bit, AV1 10-bit · up to 1080p',
      'AAC, MP3, Opus, FLAC · up to 5.1',
    ]);
  });

  test('ticking keeps the table order; the last device stays ticked', () => {
    expect(toggleDevice(['jellyfinFireTv'], 'chrome', true)).toEqual(['chrome', 'jellyfinFireTv']);
    expect(toggleDevice(['chrome', 'jellyfinAndroid'], 'chrome', false)).toEqual(['jellyfinAndroid']);
    expect(toggleDevice(['chrome'], 'chrome', false)).toEqual(['chrome']);
    expect(toggleDevice(['chrome'], 'chrome', true)).toEqual(['chrome']);
  });
});

describe('the draft', () => {
  const detail = (overrides: Partial<PlaybackProfileDetail> = {}): PlaybackProfileDetail =>
    ({
      libraryId: 'l1',
      libraryKind: 'series',
      profileId: 'p1',
      name: 'Series',
      mode: 'devices',
      devices: ['chrome', 'jellyfinAndroid'],
      target: targetForDevices(['chrome', 'jellyfinAndroid']),
      derivedMaxHeight: 1080,
      keepOriginal: false,
      deviceTableVersion: 1,
      devicesAvailable: [],
      ...overrides,
    }) as PlaybackProfileDetail;

  test('from the stored profile, in either mode', () => {
    expect(draftOf(detail())).toEqual({ mode: 'devices', devices: ['chrome', 'jellyfinAndroid'], keepOriginal: false });
    expect(draftOf(detail({ maxHeightOverride: null }))).toEqual({
      mode: 'devices',
      devices: ['chrome', 'jellyfinAndroid'],
      maxHeightOverride: null,
      keepOriginal: false,
    });
    const target = targetForDevices(['jellyfinFireTv']);
    expect(draftOf(detail({ mode: 'custom', target, keepOriginal: true }))).toEqual({ mode: 'custom', target, keepOriginal: true });
  });

  test("its target: the devices' with the cap override, or the one edited directly", () => {
    expect(draftTarget({ mode: 'devices', devices: ['chrome'], maxHeightOverride: 720, keepOriginal: false }).video.maxHeight).toBe(720);
    expect(draftTarget({ mode: 'devices', devices: ['chrome', 'jellyfinAndroid'], keepOriginal: false }).video.maxHeight).toBe(1080);
    const target = targetForDevices(['jellyfinFireTv']);
    expect(draftTarget({ mode: 'custom', target, keepOriginal: false })).toBe(target);
  });

  test('"Edit directly" starts from the current target; "Reset to devices" goes back to the stored devices', () => {
    const edited = editDirectly({ mode: 'devices', devices: ['chrome'], maxHeightOverride: 720, keepOriginal: true });
    expect(edited).toEqual({ mode: 'custom', target: targetForDevices(['chrome'], 720), keepOriginal: true });
    expect(resetToDevices(edited, detail({ mode: 'custom', maxHeightOverride: 720 }))).toEqual({
      mode: 'devices',
      devices: ['chrome', 'jellyfinAndroid'],
      maxHeightOverride: 720,
      keepOriginal: true,
    });
  });

  test('the line beside Save says what changed', () => {
    const stored = detail();
    expect(changeLine(draftOf(stored), stored)).toBeUndefined();
    expect(changeLine({ mode: 'devices', devices: ['chrome'], keepOriginal: false }, stored)).toBe('You changed the device list');
    expect(changeLine({ mode: 'devices', devices: ['chrome', 'jellyfinAndroid'], maxHeightOverride: null, keepOriginal: true }, stored)).toBe(
      'You changed the resolution cap and "Keep the original"',
    );
    expect(changeLine(editDirectly(draftOf(stored)), stored)).toBe('You edited the target');
  });
});

describe('the target edited directly', () => {
  test("the editor's options", () => {
    expect(optionItems(['mp4', 'mkv'])).toEqual([
      { value: 'mp4', label: 'MP4' },
      { value: 'mkv', label: 'MKV' },
    ]);
    expect(CHANNEL_ITEMS).toEqual([
      { value: 1, label: '1.0' },
      { value: 2, label: '2.0' },
      { value: 6, label: '5.1' },
      { value: 8, label: '7.1' },
    ]);
    expect(BIT_DEPTH_ITEMS).toEqual([
      { value: 8, label: '8-bit' },
      { value: 10, label: '10-bit' },
    ]);
    expect(HEIGHT_ITEMS).toEqual([
      { value: 'none', label: 'No cap' },
      { value: '2160', label: '2160p' },
      { value: '1440', label: '1440p' },
      { value: '1080', label: '1080p' },
      { value: '720', label: '720p' },
      { value: '480', label: '480p' },
    ]);
    expect(HDR_ITEMS).toEqual([
      { value: 'sdrOnly', label: 'SDR only' },
      { value: 'hdr10', label: 'HDR10' },
      { value: 'dv', label: 'Dolby Vision' },
    ]);
  });

  test('the first entry is what a remux or transcode produces', () => {
    expect(setFirst(['h264', 'av1'], 'av1')).toEqual(['av1', 'h264']);
    expect(setFirst(['h264'], 'hevc')).toEqual(['hevc', 'h264']);
  });

  test('adding keeps the first entry first; removing never empties the list', () => {
    const order = ['aac', 'ac3', 'eac3', 'opus', 'flac', 'mp3'] as const;
    expect(setIncluded(['opus', 'aac'], 'flac', true, order)).toEqual(['opus', 'aac', 'flac']);
    expect(setIncluded(['opus', 'aac', 'flac'], 'opus', false, order)).toEqual(['aac', 'flac']);
    expect(setIncluded(['aac'], 'aac', false, order)).toEqual(['aac']);
  });

  test('"Keep in the file" needs MKV first; text and burn-in need a text format', () => {
    const target = targetForDevices(['jellyfinFireTv']);
    expect(targetProblems(target)).toEqual([]);
    expect(targetProblems({ ...target, subtitles: { mode: 'keep', textFormats: [] } })).toEqual(['Keep in the file needs MKV as the first container.']);
    expect(targetProblems({ ...target, containers: ['mkv', 'mp4'], subtitles: { mode: 'keep', textFormats: [] } })).toEqual([]);
    expect(targetProblems({ ...target, subtitles: { mode: 'text', textFormats: [] } })).toEqual(['Pick at least one text subtitle format.']);
    expect(subtitleModeItems(['mp4', 'mkv'])).toEqual([
      { value: 'text', label: 'Convert to text, separate file' },
      { value: 'keep', label: 'Keep in the file (MKV first)', disabled: true },
      { value: 'burnIn', label: 'Burn in forced subtitles, the rest as separate files' },
    ]);
    expect(subtitleModeItems(['mkv'])[1]).toEqual({ value: 'keep', label: 'Keep in the file (MKV first)', disabled: false });
  });
});

// The switch says where the original goes.
test('"Keep the original"', () => {
  expect(KEEP_ORIGINAL).toEqual({
    label: 'Keep the original',
    description: 'The original is kept outside the library for re-preparation. Jellyfin only sees the prepared file. Applies to later preparations.',
  });
});

describe('the target table (the Target format card)', () => {
  test("the default devices' target", () => {
    expect(targetRows(targetForDevices(['chrome', 'jellyfinAndroid']))).toEqual([
      { label: 'Video', value: 'H.264 · SDR only · resolution cap 1080p · bit-rate cap none' },
      { label: 'Audio', value: 'AAC, MP3, Opus, FLAC · channels kept up to 2.0' },
      { label: 'Subtitles', value: 'Convert to text, separate file (SRT, ASS)' },
      { label: 'Container', value: 'MP4' },
    ]);
  });

  test('10-bit codecs, HDR, no cap, a bit-rate cap and surround audio', () => {
    const target = targetForDevices(['jellyfinFireTv'], null);
    expect(targetRows({ ...target, video: { ...target.video, maxBitrateKbps: 8000 } })).toEqual([
      { label: 'Video', value: 'H.264, HEVC 10-bit · HDR10 · resolution cap none · bit-rate cap 8 Mbit/s' },
      { label: 'Audio', value: 'AAC, AC-3, E-AC-3, MP3, Opus, FLAC · channels kept up to 5.1' },
      { label: 'Subtitles', value: 'Convert to text, separate file (SRT)' },
      { label: 'Container', value: 'MP4, MKV' },
    ]);
  });

  test('the other subtitle modes', () => {
    const target = targetForDevices(['jellyfinFireTv']);
    expect(targetRows({ ...target, subtitles: { mode: 'keep', textFormats: [] } })[2]?.value).toBe('Keep in the file');
    expect(targetRows({ ...target, subtitles: { mode: 'burnIn', textFormats: ['srt'] } })[2]?.value).toBe(
      'Burn in forced subtitles, the rest as separate files (SRT)',
    );
  });
});
