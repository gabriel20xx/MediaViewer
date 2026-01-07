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
- Web UI: http://localhost:8080

## Environment

Server:
- `DATABASE_URL` (required): Postgres connection string
- `MEDIA_ROOT` (required): path inside container to scan (default in compose: `/media`)
- `PORT` (optional): default `8080`

Desktop client:
- `SERVER_URL` (optional): default `http://localhost:8080`

## Notes

- Media scanning is recursive.
- For a media file `SomeVideo.mp4`, a sidecar funscript `SomeVideo.funscript` is auto-detected.
