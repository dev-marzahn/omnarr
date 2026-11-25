# omnarr

One self-hosted app that finds series, movies and anime, downloads them, prepares them to direct-play and plays them.

## People

**Admin**:
The account that runs the installation: library, indexers, downloads, Issues and settings. Every Admin is also a Viewer.
_Avoid_: User, owner

**Viewer**:
An account that only watches: it browses and plays the library and keeps its own watch state, and never sees how the media got there.
_Avoid_: User, member, profile

## Playback

**Player**:
omnarr's own playback client, which plays prepared files as stored, with no transcoding.
_Avoid_: Jellyfin, client

**Primary**:
A Unit's full-quality file, prepared to fit the library's ticked Platforms.
_Avoid_: Main file, source, original

**Universal ladder**:
Optional H.264 copies of the Primary at the heights a library ticks, which every device plays and a slow connection can carry.
_Avoid_: Variants, transcodes, fallback

**Rung**:
One height on the Universal ladder, such as 720p.
_Avoid_: Quality, variant

**Platform**:
A kind of device the Player runs on, such as a desktop browser or Android TV, that a playback profile ticks.
_Avoid_: Device, client

**Watch state**:
One Viewer's resume position and watched mark for one Unit.
_Avoid_: Progress, history
