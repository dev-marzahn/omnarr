// The built-in device table: what each reference client direct-plays,
// the platform's assumption until a manual check confirms it on the devices.
// A change ships as a new `DEVICE_TABLE_VERSION` and a reference seed that
// recomputes every profile in `devices` mode.
import { z } from 'zod';

import type { TargetAudioCodec, TargetContainer, TargetFormat, TargetHdr, TargetVideoCodec, TextSubtitleFormat } from './playback.ts';

export const DeviceId = z.enum(['chrome', 'jellyfinAndroid', 'jellyfinFireTv']);
export type DeviceId = z.infer<typeof DeviceId>;

export const DEVICE_TABLE_VERSION = 1;

export type DeviceCapabilities = {
  /** The device card's title. */
  name: string;
  subtitle: string;
  containers: TargetContainer[];
  video: { codec: TargetVideoCodec; maxBitDepth: 8 | 10 }[];
  /** null: no cap. */
  maxHeight: number | null;
  hdr: TargetHdr;
  audio: TargetAudioCodec[];
  maxChannels: number;
  textSubtitles: TextSubtitleFormat[];
};

export const DEVICE_TABLE: Record<DeviceId, DeviceCapabilities> = {
  chrome: {
    name: 'Chrome',
    subtitle: 'Jellyfin web',
    containers: ['mp4'],
    video: [
      { codec: 'h264', maxBitDepth: 8 },
      { codec: 'av1', maxBitDepth: 10 },
    ],
    maxHeight: null,
    hdr: 'sdrOnly',
    audio: ['aac', 'mp3', 'opus', 'flac'],
    maxChannels: 2,
    textSubtitles: ['srt', 'ass'],
  },
  jellyfinAndroid: {
    name: 'Jellyfin Android app',
    subtitle: 'Phones and tablets',
    containers: ['mp4'],
    video: [{ codec: 'h264', maxBitDepth: 8 }],
    maxHeight: 1080,
    hdr: 'sdrOnly',
    audio: ['aac', 'mp3', 'opus', 'flac'],
    maxChannels: 2,
    textSubtitles: ['srt', 'ass'],
  },
  jellyfinFireTv: {
    name: 'Jellyfin on Fire TV',
    subtitle: 'Fire TV Stick 4K',
    containers: ['mp4', 'mkv'],
    video: [
      { codec: 'h264', maxBitDepth: 8 },
      { codec: 'hevc', maxBitDepth: 10 },
    ],
    maxHeight: 2160,
    hdr: 'hdr10',
    audio: ['aac', 'ac3', 'eac3', 'mp3', 'opus', 'flac'],
    maxChannels: 6,
    textSubtitles: ['srt'],
  },
};

/** The devices first run ticks for both libraries. */
export const DEFAULT_DEVICES: DeviceId[] = ['chrome', 'jellyfinAndroid'];

/**
 * The target every ticked device plays.
 * `maxHeightOverride` replaces the derived cap; `null` removes it; absent
 * keeps the derived one.
 */
export function targetForDevices(
  devices: readonly DeviceId[],
  maxHeightOverride?: number | null,
  table: Record<DeviceId, DeviceCapabilities> = DEVICE_TABLE,
): TargetFormat {
  const ticked = devices.map((id) => table[id]);
  const [first] = ticked;
  if (!first) throw new Error('targetForDevices needs at least one device');
  /** The first device's values that every other device has too, in the first device's order. */
  const intersect = <T>(of: (device: DeviceCapabilities) => readonly T[]): T[] =>
    of(first).filter((value) => ticked.every((device) => of(device).includes(value)));

  const codecs = intersect((device) => device.video.map((video) => video.codec));
  /** The lowest bit depth any ticked device plays the codec at; 8 for a codec not every device plays. */
  const bitDepth = (codec: TargetVideoCodec): 8 | 10 =>
    codecs.includes(codec) ? (Math.min(...ticked.map((device) => device.video.find((video) => video.codec === codec)!.maxBitDepth)) as 8 | 10) : 8;
  const caps = ticked.map((device) => device.maxHeight).filter((cap): cap is number => cap !== null);
  const derivedCap = caps.length ? Math.min(...caps) : null;
  const containers = intersect((device) => device.containers);
  const textFormats = intersect((device) => device.textSubtitles);

  return {
    containers: containers.length ? containers : ['mp4'],
    video: {
      codecs,
      maxHeight: maxHeightOverride === undefined ? derivedCap : maxHeightOverride,
      maxBitrateKbps: null,
      hdr: HDR_ORDER.find((level) => ticked.some((device) => device.hdr === level))!,
      maxBitDepth: { h264: 8, hevc: bitDepth('hevc'), av1: bitDepth('av1') },
    },
    audio: { codecs: intersect((device) => device.audio), maxChannels: Math.min(...ticked.map((device) => device.maxChannels)) },
    subtitles: { mode: 'text', textFormats: textFormats.length ? textFormats : ['srt'] },
  };
}

/** Lowest first: the target takes the lowest level any ticked device has. */
const HDR_ORDER: TargetHdr[] = ['sdrOnly', 'hdr10', 'dv'];
