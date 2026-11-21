# NZBGet fixtures

JSON-RPC responses for `failures.test.ts` and the fake NZBGet (`test/fakes/nzbget.ts`). Each entry carries the platform's correlation tag as the post-processing parameter `omnarr` (`grab-<case>`); the tests find entries by it.

## Recorded

`history.json`, `listgroups-fetching.json` and `listgroups-halfway.json` are verbatim responses of a real NZBGet 26.3 (`nzbgetcom/nzbget:latest`, 2026-11-17), recorded as follows:

- NZBGet's only news server was a throwaway NNTP server on the host that served yEnc articles from local files and answered `430` for articles left out on purpose. An HTTP server on the host served the NZBs.
- Each case was added the way the adapter adds it: `append("", <NZB URL>, <category>, 0, false, false, "", 0, "FORCE", [{ "omnarr": "grab-<case>" }])`.
- `listgroups` was read while each article of one NZB was held back for 60 s (`grab-slow`) and another NZB URL was held back for 60 s (`grab-slownzb`): after 8 s (`listgroups-fetching.json`: `grab-slow` `DOWNLOADING` with nothing in yet, `grab-slownzb` a `URL` entry in `FETCHING`) and after 78 s (`listgroups-halfway.json`: `grab-slow` with 2 of 4 articles in, `grab-slownzb` fetched and `QUEUED`). `history(false)` was read at the same time; every other case had finished by then.

| Tag                                               | What NZBGet got                                                                 | Status                        |
| ------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------- |
| `grab-ok`                                         | one `.mkv`, all articles                                                        | `SUCCESS/HEALTH`              |
| `grab-unpackok`                                   | a `.7z` holding an `.mkv`                                                       | `SUCCESS/UNPACK`              |
| `grab-missing`                                    | every article missing                                                           | `FAILURE/HEALTH`              |
| `grab-partmissing`                                | one of four articles missing, no par files                                      | `FAILURE/HEALTH`              |
| `grab-parfail`                                    | an `.mkv` damaged beyond its 2 recovery blocks, plus `.par2` and `.vol0+2.par2` | `FAILURE/PAR`                 |
| `grab-password`                                   | a `.7z` with an encrypted header (`7z -mhe=on -p…`)                             | `WARNING/PASSWORD`            |
| `grab-broken`                                     | a `.7z` with 32 bytes overwritten                                               | `FAILURE/UNPACK`              |
| `grab-doesnotexist`, `grab-paused`, `grab-queued` | an NZB URL that answered 404                                                    | `FAILURE/FETCH` (`Kind: URL`) |

The `URL` fields hold the recorder's local addresses; a real one is an indexer link with an API key, which is why the adapter never copies it.

`version.json`, `loadconfig.json`, `testserver.json`, `history-bad.json` and `listgroups-uploaded.json` are verbatim responses of `nzbgetcom/nzbget:v26.3` (2026-11-18), reformatted only, recorded as follows:

- The container ran as the e2e runs it (`PUID=1000`, `PGID=1000`, a host directory at `/config`), started from an `nzbget.conf` holding only the control keys setup writes. The news servers were the repo's NNTP fake (`e2e/fakes/nntp/server.ts`) on the host, once with AUTHINFO (`u`/`p`) and once without, the second behind a proxy that held back each article request of the `slow` and `uploaded` NZBs (built with `e2e/fakes/usenet/release.ts`).
- `version.json` and `loadconfig.json` were read right after that first start. `loadconfig.json`'s `ControlPassword` is replaced with `fixture-control-password`.
- `testserver.json` holds three calls of `testserver(host, port, username, password, false, "", 15, 2)`: `ok` with the right login on the AUTHINFO fake, `authRejected` with a wrong password on it, `unreachable` with a port on the host where nothing listened. `host.docker.internal` is the recorder's host name.
- Every NZB was added as uploaded content, the way the worker adds it: `append("<name>.nzb", base64(content), <category>, 0, false, false, "", 0, "FORCE", [{ "omnarr": "grab-<case>" }])`. `listgroups-uploaded.json` was read 4.5 s after adding `grab-uploaded`, with 1 of its 5 articles in. `history-bad.json` is `history(false)` after the three cases below; the `DestDir` fields hold the recorder's paths.

| Tag            | What NZBGet got                                                                             | Status                                                |
| -------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `grab-bad`     | a well-formed NZB with no `<file>` (log: `Error parsing nzb-file …: file has no content`)   | `FAILURE/SCAN` (`DeleteStatus SCAN`)                  |
| `grab-badxml`  | content that isn't XML (log: `Start tag expected, '<' not found`)                           | `FAILURE/SCAN` (`DeleteStatus SCAN`)                  |
| `grab-markbad` | a good NZB that downloaded (`SUCCESS/HEALTH`), then `editqueue("HistoryMarkBad", "", [id])` | `FAILURE/BAD` (`MarkStatus BAD`, `DeleteStatus NONE`) |

## Derived by hand

`history-derived.json` holds states that were not quick to produce, written from the recorded entries with the fields NZBGet's API documentation gives for them. Only the fields the adapter reads are kept.

| Tag                  | Status                                                                | Why it is there                                                       |
| -------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `grab-repaired`      | `SUCCESS/ALL`, `Health` 950, `FailedArticles` 2, `ParStatus SUCCESS`  | par repaired the missing articles: not a failure                      |
| `grab-space`         | `WARNING/SPACE`, `UnpackStatus SPACE`, also repaired missing articles | `diskFull` wins over everything                                       |
| `grab-damaged`       | `WARNING/DAMAGED`, `Health` 925, `FailedArticles` 3, no par           | missing articles without `FAILURE/HEALTH`                             |
| `grab-parmissing`    | `FAILURE/PAR` with `Health` 850, `FailedArticles` 6                   | missing articles win over the par failure they caused                 |
| `grab-deletedhealth` | `DELETED/HEALTH` (`HealthCheck=delete`)                               | missing articles                                                      |
| `grab-parked`        | `DELETED/MANUAL`                                                      | what `GroupParkDelete` leaves (seen on the real NZBGet, not recorded) |

The queue stages other than `QUEUED`, `DOWNLOADING` and `FETCHING` (`PAUSED` and the post-processing ones) are made in the tests by changing `Status` on a recorded entry.

## Seen on the real NZBGet, relied on by the adapter

- `PPParameters` are read as one struct member per parameter: `[{ "omnarr": "<tag>" }]` stores `omnarr=<tag>`, while `[{ "Name": "omnarr", "Value": "<tag>" }]` stores two parameters, `Name=omnarr` and `Value=<tag>`.
- Without `DupeMode FORCE`, adding an NZB whose name is already in the history puts it straight into the history as `DELETED/COPY`.
- `append` returns the new `NZBID`; a URL entry keeps that ID once its NZB is fetched.
- `editqueue` returns `false` for an ID it doesn't hold, and a JSON-RPC error (`Invalid action`) for an unknown command. An unknown method is the error `Invalid procedure`.
- Wrong credentials answer HTTP 401.
- `HistoryFinalDelete` removes the record; NZBGet deletes the files of a failed download and keeps those of a successful one. `GroupParkDelete` keeps the files and leaves a `DELETED/MANUAL` record.
- `testserver`'s parameters are `(host, port, username, password, encryption, cipher, timeout, certVerificationLevel)`, as [NZBGet's API docs](https://github.com/nzbgetcom/nzbget/tree/develop/docs/api) give them. It returns a string, never an error: `""` on success (also with no credentials on a server that needs none), otherwise NZBGet's message. Seen besides the recorded ones: `Could not resolve hostname <host>: Error -2 - Name does not resolve`, `Connection to <host> failed: Error 110 - Operation timed out` (after the timeout), and `Unknown error` for encryption on against a plain-text server.
- An uploaded NZB that NZBGet can't use is not refused: `append` returns a new `NZBID` and the item goes straight to the history as `FAILURE/SCAN` (`DeleteStatus SCAN`). `FAILURE/BAD` is `MarkStatus BAD`: the user (or a script) marked the item bad, for example with `HistoryMarkBad`. Marking kept the downloaded files.
- An uploaded NZB is an ordinary `NZB` item with `URL` `""` and `NZBFilename` the name given to `append`. NZBGet adds a `*Unpack:` parameter next to `omnarr` in `Parameters`.
- From a file holding only the control keys, NZBGet 26.3 starts and answers JSON-RPC. It logs `[ERROR] Could not read configuration templates` and `[ERROR] No servers are configured`, and the WebUI answers HTTP 503 (`WebDir` is empty). The entrypoint leaves an existing `nzbget.conf` alone (it copies the template only when the file is absent) and runs NZBGet as uid 1000.
- `loadconfig` returns only the options in the file: 6 for that file. `config` returns every option with the value in use (121): the built-in defaults include `MainDir=/config/downloads` (the home directory of the image's user), `DestDir=${MainDir}/dst`, `InterDir=` (empty), `CertStore=` (empty), `CertCheck=no`, `KeepHistory=7`, `DupeCheck=yes`, `HealthCheck=none`, `Unpack=no`, `ContinuePartial=no`, `WebDir=` and `ConfigTemplate=` (empty). The image's template sets `CertStore=${AppDir}/cacert.pem` (`/app/nzbget/cacert.pem`, `AppDir=/app/nzbget`) and `CertCheck=yes`; `/etc/ssl/certs/ca-certificates.crt` is also in the image. After `CertStore` was saved and reloaded, NZBGet still warned `'CertCheck' is disabled`, so `CertStore` alone doesn't turn certificate checks on.
- The template's comment on `KeepHistory` (days): `Value "0" disables history. Duplicate check will not work.` Expired items are hidden (with `DupeCheck`) or removed (without), and the files of a failed item are deleted then.
- `saveconfig` writes exactly the options it gets, in their order, and returns `true`. Saving the full `loadconfig` list plus three changed or added options wrote all of them. Saving that list without `KeepHistory`, `MainDir` and the `Category2.*` options removed them from the file, and after `reload` `config` showed `KeepHistory=7` and no `Category2`.
- `reload` returns `true` and restarts NZBGet in the same container. The old instance kept answering `version` for 50–150 ms after `reload` returned, then the port refused connections, and the new one answered 400–730 ms after the call (`status`'s `UpTimeSec` starts again at 0). So a `version` answer right after `reload` doesn't show the new config is applied.
- The queue and the history survive `reload`; a running download continues with the same `NZBID` and `Parameters`. The article in flight is cancelled and fetched again. With `ContinuePartial=no` (the built-in default) the file's finished articles are lost too: 3 of 10 were in, and the download started again at article 1 (`SuccessArticles` 0). With `ContinuePartial=yes` it went on at article 4 with 3 of 10 kept.
- After `saveconfig` with a few options and `reload`, options left out fell back to their defaults (`MainDir` and `DestDir` did), so `saveconfig` replaces the whole configuration. That is why `applyConfig` saves the full list `loadconfig` read, with the platform's options merged in (`src/clients/nzbgetConfig.ts`).
