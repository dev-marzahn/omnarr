# Sample media

The files the Newznab and NNTP fakes serve as the e2e catalogue's releases (`../catalogue.ts`). All of them are generated from ffmpeg's `testsrc2` pattern and a 440 Hz tone, not taken from anywhere.

| File                      | Release                                                           | What it is                                                                                                                       |
| ------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `webdl.mkv`               | `Harbour.Lights.S01E01.1080p.WEB-DL.DDP5.1.H.264-GRPB`            | A copy of `apps/worker/test/fixtures/media/webdl.mkv`: 1920×1080 H.264, 2 s; E-AC-3 5.1; SubRip English and German; 549 KB       |
| `sample.mkv`              | both `Harbour.Lights.S01E02…` releases (GRPB's is served damaged) | 2 s, H.264 (High, 160×90, 25 fps) and AAC (LC, 48 kHz stereo) in Matroska, about 19 KB                                           |
| `generated/hevc-1min.mkv` | `Harbour.Lights.S02E01.1080p.WEB-DL.DDP5.1-GRPB`                  | A minute of 1920×1080 HEVC Main 10 (libx265 `ultrafast`, 1 Mbit/s) with E-AC-3 5.1, about 10 MB; not committed, see below        |
| `cut-short.mkv`           | `Harbour.Lights.S02E02.1080p.WEB-DL.DDP5.1-GRPB`                  | A copy of `apps/worker/test/fixtures/media/cut-short.mkv`: 320×180 HEVC Main 10 whose header says 8 s, with about 4 s left in it |

The two copies keep the fakes self-contained: each fake's container mounts only `e2e/fakes/`. Copy them again when the worker's fixtures are regenerated (`apps/worker/test/fixtures/media/README.md`).

**The S02E01 file** is generated, since 10 MB is too big to commit. `e2e/stack.ts` makes it before the stack comes up, with the ffmpeg arguments in `GENERATED_MEDIA` (`../catalogue.ts`), in a container of the worker image (so the host needs no ffmpeg), and keeps it under `generated/` (ignored by git and Docker) for later runs; on a 16-core machine it takes about 20 s. A minute is enough: the e2e only needs the transcode to still be running when it kills the worker, a second or two after the first progress report (the e2e writes progress every second, `progressMs` in `E2E_LIMITS`), and the transcode then runs once more from the start. The worker's ffmpeg transcodes this source at 4× to 9× real time on a 16-core Docker host, so a minute gives 7 to 16 s per run, which still leaves the kill several seconds; a slower CI runner has proportionally more. Delete the file to make it again.

`sample.mkv` was made with ffmpeg 8 with libx264 (the bytes may differ between ffmpeg builds):

```sh
ffmpeg -f lavfi -i testsrc2=size=160x90:rate=25:duration=2 -f lavfi -i sine=frequency=440:sample_rate=48000:duration=2 \
  -c:v libx264 -preset veryslow -crf 35 -pix_fmt yuv420p -profile:v high -c:a aac -b:a 32k -ac 2 \
  -map_metadata -1 -fflags +bitexact -flags:v +bitexact -flags:a +bitexact -shortest sample.mkv
```

Without ffmpeg on the host, run the same command in a container, for example `docker run --rm -v "$PWD":/out -w /out --entrypoint ffmpeg omnarr-worker <the arguments above>`.
