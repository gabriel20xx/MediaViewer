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

## Notes

- Media scanning is recursive.
- For a media file `SomeVideo.mp4`, a sidecar funscript `SomeVideo.funscript` is auto-detected.
