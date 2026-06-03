# Stockkar Backend Docker Deploy

This backend can run as a Docker container on each user's AWS server.

## Local Test

```bash
docker compose up -d --build
curl http://127.0.0.1:7777/api/auth/status
```

Expected response:

```json
{"ok":true,"loggedIn":false}
```

## Runtime

- Container port: `7777`
- Host binding inside Docker: `0.0.0.0`
- Persistent data volume: `/app/data`
- Runtime files:
  - `/app/data/order_log.json`
  - `/app/data/algo_schedule.json`

## Update

For a user-owned AWS server:

```bash
docker compose pull
docker compose up -d
```

For the first self-hosted version, CloudFormation can install Docker, clone or download this repo, and run `docker compose up -d --build`.
