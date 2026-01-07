# MediaViewer

Monorepo:
- `server/` Node.js (Express) API + Web UI, Docker-ready, PostgreSQL via `DATABASE_URL`
- `client-desktop/` Electron Windows desktop client

## Quick start (Docker)

1) Create a media folder (example):

```powershell
New-Item -ItemType Directory -Force .\media
```

2) Start Postgres + server:

```powershell
docker compose up --build
```

3) Open:
- Web UI: http://localhost:3000

## Environment

Server:
- `DATABASE_URL` (required): Postgres connection string
- `MEDIA_ROOT` (optional): path inside container to scan (defaults to `/media`)
- `PORT` (optional): default `3000`

Database:
- The server bootstraps its tables on startup (no Prisma required).

Desktop client:
- `SERVER_URL` (optional): default `http://localhost:3000`

## Desktop client (Windows)

From `client-desktop/`:

- Install deps: `npm install`
- Build: `npm run build`
- Run: `npm run start`

### Build a Windows EXE

From `client-desktop/`:

- `npm run package:win`

This produces a portable executable in `client-desktop/release/` (example: `MediaViewer 0.1.0.exe`).

### Run via PowerShell script

From repo root:

```powershell
./run-desktop-client.ps1
```

Optional (point at a different server):

```powershell
./run-desktop-client.ps1 -ServerUrl http://localhost:3000
```

## DeoVR + HereSphere (VR players)

The server exposes lightweight endpoints that VR players can use as a remote library.

DeoVR:
- Library endpoint: `http://<server-host>:3000/deovr`
- Single-video endpoint (deeplink JSON): `http://<server-host>:3000/deovr/video/<mediaId>`
- Typical deeplink format: `deovr://http://<server-host>:3000/deovr`

HereSphere:
- Library endpoint: `http://<server-host>:3000/heresphere`
- Single-video endpoint: `http://<server-host>:3000/heresphere/video/<mediaId>`

Notes:
- The Web UI shows “DeoVR” and “HereSphere” buttons on VR-tagged videos.
- HereSphere integration is intended for HereSphere’s built-in browser “Web Stream” flow (open the `/heresphere` URL inside HereSphere).

## VR metadata detection (ffprobe)

MediaViewer will try to detect VR metadata (stereo layout, projection, 180/360 FOV) from the video container/stream using `ffprobe` when it’s available.

- Docker: the server image includes `ffprobe` (via `ffmpeg`).
- Non-Docker: install FFmpeg so `ffprobe` is on `PATH`, or set `FFPROBE_PATH` to the full path of `ffprobe.exe`.

After enabling `ffprobe`, run a rescan (`POST /api/scan` or click “Rescan” in the Web UI) to backfill the DB columns.

## Notes

- Media scanning is recursive.
- For a media file `SomeVideo.mp4`, a sidecar funscript `SomeVideo.funscript` is auto-detected.
