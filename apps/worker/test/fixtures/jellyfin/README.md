# Jellyfin 12.4 fixtures

Recorded on 2026-11-18 from a fresh `jellyfin/jellyfin@sha256:fea863d0cd9ec445985d9c75fc6ed64e38a1d2766cf0c250a33d553f4fc1b771` (12.4.0) container, one series episode and one movie on disk, every fetcher off. `test/fakes/jellyfin.ts` takes its answers' shapes from these files and its status codes from the table below. The tokens and IDs in them belong to that throwaway container.

| File                                                       | Call                                                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `system-info-public.json`, `system-info-public-after.json` | `GET /System/Info/Public`, before and after the wizard                                                        |
| `startup-user-get.json`                                    | `GET /Startup/User` before the wizard's user is set                                                           |
| `authenticate.json`                                        | `POST /Users/AuthenticateByName` with `Authorization: MediaBrowser Client=…, Device=…, DeviceId=…, Version=…` |
| `auth-keys-get.json`                                       | `GET /Auth/Keys` after two `POST /Auth/Keys?app=omnarr`                                                       |
| `system-info.json`                                         | `GET /System/Info` with the key                                                                               |
| `virtualfolders.json`                                      | `GET /Library/VirtualFolders` after creating Series and Movies                                                |
| `items-series.json`                                        | `GET /Items?ParentId=<library item>&Recursive=true&IncludeItemTypes=Series&Fields=Path`                       |
| `items-episodes.json`                                      | `GET /Items?ParentId=<series>&Recursive=true&IncludeItemTypes=Episode&Fields=Path`                            |
| `items-movies.json`                                        | `GET /Items?ParentId=<library item>&Recursive=true&IncludeItemTypes=Movie&Fields=Path`                        |
| `sessions.json`                                            | `GET /Sessions?activeWithinSeconds=600` with no client playing                                                |
| `sessions-playing.json`                                    | `GET /Sessions?activeWithinSeconds=600` with the key, while two clients play (see below)                      |
| `system-configuration.json`                                | `GET /System/Configuration` with the key, right after the wizard (2026-11-24)                                 |
| `branding-configuration.json`                              | `GET /System/Configuration/branding` with the key, right after the wizard (2026-11-24)                        |

Status codes 12.4 answered:

| Call                                                                                                        | Status                                                                               |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `POST /Startup/Configuration`, `POST /Startup/User`, `POST /Startup/RemoteAccess`, `POST /Startup/Complete` | 204                                                                                  |
| `GET /Startup/User` after `Complete`                                                                        | 401                                                                                  |
| `POST /Users/AuthenticateByName`, wrong password                                                            | 401                                                                                  |
| `POST /Auth/Keys?app=omnarr` (session token), `DELETE /Auth/Keys/<key>`, `POST /Sessions/Logout`            | 204                                                                                  |
| The session token after `POST /Sessions/Logout`                                                             | 401                                                                                  |
| `GET /System/Info` with an unknown key                                                                      | 401                                                                                  |
| `POST /Library/VirtualFolders?…&refreshLibrary=false`                                                       | 204                                                                                  |
| `POST /Items/<library or series item>/Refresh?Recursive=true&…`                                             | 204                                                                                  |
| `POST /Items/<unknown ID>/Refresh`                                                                          | 404 (400 for the all-zero GUID)                                                      |
| `GET /Items?ParentId=<unknown ID>&…`                                                                        | **400**                                                                              |
| `POST /Items/<item of a library deleted with DELETE /Library/VirtualFolders>/Refresh`, and its listing      | 204 and 200, still, after a full `/Library/Refresh`                                  |
| `POST /Users/Password?userId=<admin>` `{ NewPw }` with the key                                              | 204; the new password signs in (200), the old one doesn't (401), the key still works |
| `POST /Users/Password?userId=<admin>` with an unknown key                                                   | 401                                                                                  |
| `POST /Users/Password?userId=<unknown ID>`                                                                  | 404                                                                                  |

A second check on 2026-11-18, also on 12.4: **a library-item refresh never indexes the first content of a library that was created empty.** A Series or Movies library made with `refreshLibrary=false` (or `true`), refreshed or not while empty, then given a series folder or a movie folder: `POST /Items/<library item>/Refresh?Recursive=true&…` answers 204 and indexes nothing, also when sent twice; Jellyfin logs "Library folder … is inaccessible or empty, skipping". `POST /Library/Refresh` indexes it within 4 s. Once the library holds an item, a library-item refresh finds a further new series within 2 s. The fake models this.

A third check on 2026-11-18, also on 12.4, for the play poller (`sessions-playing.json`): one episode in a Series library, and the admin signed in from two clients.

- **"Spike Tablet"** (`Client="Spike Client"`, `DeviceId="spike-tablet-1"`) sent `POST /Sessions/Playing` with `PlayMethod: "DirectPlay"` (204). Its session carries `NowPlayingItem.Id` (the episode's item) and `PlayState.PlayMethod: "DirectPlay"`, and has **no `TranscodingInfo`**.
- **"Chrome"** (`Client="Jellyfin Web"`, `DeviceId="chrome-device-1"`) fetched a segment of `GET /Videos/<item>/main.m3u8?…&AudioCodec=mp3&TranscodeReasons=AudioCodecNotSupported,ContainerNotSupported`, which started ffmpeg, then sent `POST /Sessions/Playing` with `PlayMethod: "Transcode"` (204). Its session carries `PlayState.PlayMethod: "Transcode"` and `TranscodingInfo.TranscodeReasons: ["ContainerNotSupported", "AudioCodecNotSupported"]`, an array of names (here `IsVideoDirect: true`, `IsAudioDirect: false`). The names came from the stream URL, as jellyfin-web passes PlaybackInfo's reasons; a real browser's play wasn't part of this check.
- The API key's calls make no session. After `POST /Sessions/Playing/Stopped` (204) the tablet's session stays listed without `NowPlayingItem`, and its `PlayState` has no `PlayMethod`.
- `UserId` is the admin's ID in the form `AuthenticateByName` returns (32 hex digits, no dashes).
- 12.4's OpenAPI (`/api-docs/openapi.json`) lists `PlayMethod` as `Transcode`, `DirectStream`, `DirectPlay`, and `TranscodeReason` as the 28 names `src/jellyfin/reasons.ts` maps.

A fourth check on 2026-11-24, also on 12.4, for the branding step: a fresh server's `ServerName` is `""`, and its branding answer is `{"SplashscreenEnabled": false}`, leaving out `LoginDisclaimer` and `CustomCss` while they are null. `POST /System/Configuration` and `POST /System/Configuration/branding` answer 204 and **replace the whole object**: a branding body with only `CustomCss` drops the stored `LoginDisclaimer`. So the worker reads each object and writes it back whole. `/System/Configuration/Branding` is the same configuration. `GET /Branding/Configuration` answers the branding without a key; `GET /System/Configuration/branding` without one is 401. After the write, `GET /System/Info/Public` lists the new `ServerName`.
