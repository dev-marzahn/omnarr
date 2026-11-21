// What the worker reports at connect and in each heartbeat:
// the ffmpeg build, its encoders, and per storage area its free bytes, its
// device and whether it is writable.
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { type Capabilities, type Storage, STORAGE_AREAS, type StorageArea, type StorageSpace } from '@omnarr/contracts';

import { areaPath, type DataLayout } from './fs/layout.ts';
import { deviceAt, freeBytesAt } from './fs/space.ts';

const run = promisify(execFile);

/** Each area's free bytes and device, from `statfs` and `stat`, which write nothing. */
export async function storageSpace(layout: DataLayout): Promise<StorageSpace> {
  const entries = await Promise.all(
    STORAGE_AREAS.map(async (area) => {
      const path = areaPath(layout, area);
      const [freeBytes, device] = await Promise.all([freeBytesAt(path), deviceAt(path)]);
      return [area, { freeBytes, device }] as const;
    }),
  );
  return Object.fromEntries(entries) as StorageSpace;
}

/**
 * The write check: `access(W_OK)` for `downloads`, which writes
 * nothing there; for the other areas, creating and deleting
 * `.omnarr/write-check-<workerId>` in the area. Jellyfin and the scan skip
 * hidden folders.
 */
export async function writeCheck(layout: DataLayout, workerId: string): Promise<Record<StorageArea, boolean>> {
  const check = async (area: StorageArea): Promise<boolean> => {
    const path = areaPath(layout, area);
    try {
      if (area === 'downloads') {
        await access(path, constants.W_OK);
        return true;
      }
      const file = join(path, '.omnarr', `write-check-${workerId.replace(/[^\w.-]/g, '_')}`);
      await mkdir(join(path, '.omnarr'), { recursive: true });
      await writeFile(file, '');
      await unlink(file);
      return true;
    } catch {
      return false;
    }
  };
  const entries = await Promise.all(STORAGE_AREAS.map(async (area) => [area, await check(area)] as const));
  return Object.fromEntries(entries) as Record<StorageArea, boolean>;
}

/** The storage with the write check, as the handshake sends it. */
export async function storage(layout: DataLayout, workerId: string): Promise<Storage> {
  const [space, writable] = await Promise.all([storageSpace(layout), writeCheck(layout, workerId)]);
  return Object.fromEntries(STORAGE_AREAS.map((area) => [area, { ...space[area], writable: writable[area] }])) as Storage;
}

/** `ffmpeg -version`'s first line names the version: "ffmpeg version 7.1 Copyright …". */
export function parseFfmpegVersion(output: string): string {
  return /^ffmpeg version (\S+)/m.exec(output)?.[1] ?? 'unknown';
}

/** `ffmpeg -encoders` lists one encoder per line after the legend: " V....D libx264  …". */
export function parseEncoders(output: string): string[] {
  const listed = output.split('\n').slice(output.split('\n').findIndex((line) => line.trim().startsWith('------')) + 1);
  return listed.map((line) => /^\s[VAS][.A-Z]{5}\s+(\S+)/.exec(line)?.[1]).filter((name): name is string => !!name);
}

export async function capabilities(layout: DataLayout, workerId: string): Promise<Capabilities> {
  // No ffmpeg (a dev machine) reports `unavailable` and no encoders.
  const ffmpeg = (args: string[]) =>
    run('ffmpeg', args).then(
      (r) => r.stdout,
      () => '',
    );
  const [versionOutput, encoderOutput, areas] = await Promise.all([ffmpeg(['-version']), ffmpeg(['-hide_banner', '-encoders']), storage(layout, workerId)]);
  return { ffmpegVersion: versionOutput ? parseFfmpegVersion(versionOutput) : 'unavailable', encoders: parseEncoders(encoderOutput), storage: areas };
}
