# Media fixtures

Small media files and recorded ffprobe output for the worker's media tests: `probe.test.ts`, `subtitles.test.ts`, `archives.test.ts`, and the prepare job's tests. Everything here is committed; CI never regenerates it.

The tests that run real tools (`ffmpeg`, `ffprobe`, `lsar`, `unar`) skip with a `NOTICE:` line on stderr when a tool is missing. With `OMNARR_REQUIRE_MEDIA_TOOLS=1` (CI's worker-image job) a missing tool fails them instead (`tools.ts`).

## Generated media

Made by `scripts/make-media-fixtures.ts` (`bun run --cwd scripts make-media-fixtures`) from ffmpeg's `testsrc2` and `sine` sources, with Homebrew ffmpeg 8.0.1. All the generator's commands are in that file.

| File              | What it is                                                                                                                                                           | For                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `webdl.mkv`       | 1920×1080 H.264 8-bit, 2 s; E-AC-3 5.1 (English, default); SubRip English and German                                                                                 | a WEB-DL's plan (E-AC-3 → AAC 2.0, two sidecars, MKV → MP4)                              |
| `hevc-hdr10.mkv`  | 640×360 HEVC Main 10, 1 s, BT.2020/PQ, mastering display `G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50)`, MaxCLL 1000, MaxFALL 400; AAC mono | HDR10 probe, tonemap, HDR10 kept by x265                                                 |
| `interlaced.m2ts` | 720×576 MPEG-2, top field first, 2 s, 25 fps; MP2 mono (German), in MPEG-TS (BDAV packets)                                                                           | the deinterlace filter                                                                   |
| `fits.mp4`        | 640×360 H.264 High 8-bit, 2 s; AAC 2.0 (English); `+faststart`                                                                                                       | a file that already fits the default target; the video inside every RAR set              |
| `cut-short.mkv`   | 320×180 HEVC Main 10, 8 s, AAC 2.0, then cut to half its bytes                                                                                                       | the output check: the header still says 8 s, the transcode gives about 4 s, and it fails |
| `subtitles.mkv`   | 320×180 H.264, 2 s; AAC 2.0; subtitles at stream 2 SubRip English (default), 3 SubRip German (forced, title "Signs"), 4 ASS Japanese, 5 PGS English, 6 VobSub French | subtitle extraction, the burn-in tracks, PGS/VobSub/ASS probes                           |
| `cover-art.mp4`   | 320×180 H.264, 1 s; AAC mono; a 160×240 PNG as an attached picture                                                                                                   | cover art left out of the probe                                                          |

The HDR10 file is encoded twice: the first libx265 pass writes the mastering and light values as SEI; re-encoding from it makes ffmpeg also store them on the Matroska track, where ffprobe shows them as stream side data.

**PGS and VobSub.** ffmpeg has no PGS encoder and can't turn text into bitmaps, so the generator writes a two-event PGS stream byte by byte (`pgs()`: each event a white 100×20 box) and muxes it with `-c:s copy`. The VobSub track is ffmpeg's `dvdsub` encoder run on that PGS stream, with `-fix_sub_duration` so its clearing events end.

`cut-short.mkv` was first made from a 4 s source, whose transcode came out 1.94 s short, inside the check's 2 s tolerance. It was made again from an 8 s source with the generator's command for it alone (Homebrew ffmpeg 8.0.1), so a transcode now comes out about 4 s short and fails the check as it is; its probe JSON was recorded again. `e2e/fakes/usenet/media/` holds a copy of it and of `webdl.mkv` for the e2e releases.

**A 10-minute file** (not committed): `node scripts/make-media-fixtures.ts --long <dir>` also writes `<dir>/hevc-10min.mkv`, 10 minutes of 1920×1080 HEVC Main 10 (libx265 `ultrafast`, 1 Mbit/s) with E-AC-3 5.1 at 384 kbit/s. On the author's Mac the whole generator run took 64 s and the file came to 104 MB. The e2e doesn't use it: `e2e/stack.ts` makes a 3-minute file of the same kind in the worker image (`e2e/fakes/usenet/media/README.md` says why).

Matroska files get random UIDs, so a rerun changes their bytes but not their ffprobe JSON; `fits.mp4` comes out byte for byte the same.

## ffprobe JSON (`probe/`)

- **Recorded:** `<fixture>.json` is `ffprobe -v error -print_format json -show_format -show_streams <fixture>`, and `hevc-hdr10.mkv.frames.json` is `ffprobe -v error -print_format json -select_streams v:0 -read_intervals %+#1 -show_frames -show_entries frame=side_data_list hevc-hdr10.mkv`, both run by the generator with ffprobe 8.0.1 from this folder and re-indented to two spaces.
- **Hand-written in ffprobe's shape, not recorded:** `handwritten-dv-p8.1.mkv.json` (Dolby Vision profile 8.1, HDR10 base layer), `handwritten-dv-p5.mp4.json` (profile 5, no base-layer compatibility, no colour tags), `handwritten-hdr10plus.mkv.json` and `handwritten-hdr10plus.mkv.frames.json` (HDR10+). These should be recorded from public sample files (the Kodi test samples), but those are hundreds of megabytes each behind file-hosting links, so they weren't fetched, and ffmpeg can't make Dolby Vision or HDR10+ metadata from a test source. The side-data entries use ffprobe's names and keys (`DOVI configuration record` with `dv_profile` and `dv_bl_signal_compatibility_id`; `HDR Dynamic Metadata SMPTE2094-40 (HDR10+)`; `Mastering display metadata`; `Content light level metadata`) as `fftools/ffprobe.c` prints them, and the values are invented. Replace them with recordings when a sample is at hand.

## RAR sets (`rar/`)

Each set holds one file, a copy of `fits.mp4` as it was made (112,323 bytes, sha256 `213454f7ecb7cb3fe59bc44b1c05919c55294de793e2a468a047081062405261`), stored (`-m0`), in 40 KiB volumes.

They were made with RARLAB's `rar` 6.24 (the trial build `rarlinux-x64-624.tar.gz`, sha256 `88e22a8e84125c947637bbf28c746e338a0a63279d80f9f9d7373603875db1eb`) in a throwaway `debian:trixie-slim` `linux/amd64` container. RAR 7, which Debian's non-free `rar` package now ships, can't write RAR4 any more (`-ma4` was removed). Only the archives are committed; the free `unar` reads them in the worker image.

| Folder               | Command (in a folder holding `Show.S01E0n.mp4`)                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `rar4/`              | `rar a -ma4 -m0 -v40k -vn ../rar4/Show.S01E01.rar Show.S01E01.mp4` → `.rar`, `.r00`, `.r01`                          |
| `rar5/`              | `rar a -ma5 -m0 -v40k ../rar5/Show.S01E02.rar Show.S01E02.mp4` → `.part1.rar` … `.part3.rar`                         |
| `encrypted/`         | `rar a -ma5 -m0 -psecret ../encrypted/Show.S01E03.rar Show.S01E03.mp4` (file data encrypted, names visible)          |
| `encrypted-headers/` | `rar a -ma5 -m0 -hpsecret ../encrypted-headers/Show.S01E04.rar Show.S01E04.mp4` (names encrypted too)                |
| `truncated/`         | `rar a -ma5 -m0 -v40k ../truncated/Show.S01E05.rar Show.S01E05.mp4`, then `truncate -s <half> Show.S01E05.part3.rar` |

What `unar` 1.10.8 (Debian trixie's `unar 1.10.8+ds1-9`) does with them, as `archives.ts` relies on:

| Set                 | `lsar -j <first volume>`                                                                                    | `unar -o <dir> -D -f -q <first volume>`                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `rar4`, `rar5`      | exit 0; `lsarContents[0].XADFileName`, `XADFileSize` 112323; `lsarProperties.XADVolumes` lists every volume | exit 0; the file, byte for byte                                                                               |
| `encrypted`         | exit 0; `XADIsEncrypted: 1` on the entry and in `lsarProperties`                                            | exit 2, "This archive requires a password to unpack. Use the -p option to provide one."; leaves an empty file |
| `encrypted-headers` | exit 2 with that message and no complete JSON                                                               | exit 2 with that message                                                                                      |
| `truncated`         | exit 1; the listing plus `"lsarError": 2`                                                                   | exit 1, "Failed! (Attempted to read more data than was available)"                                            |

`lsar` and `unar` given a later volume (`part2.rar`) find the whole set by themselves. Neither prompts for a password when none is given.
