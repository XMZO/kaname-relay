# Docker Deployment

Pull and run; no `.env` file is required:

```sh
docker compose pull
docker compose up -d
```

Open `http://SERVER_IP:3000`, initialize the admin password, then create sources, channels, and rules from the WebUI.

Persistent data lives in `./data` on the host and is mounted at `/data` in the container. The default SQLite database is:

```txt
file:/data/kaname-relay.sqlite
```

The encryption key is generated automatically on first startup and persisted at:

```txt
./data/.kaname-app-secret
```

Back up that file together with the SQLite database. Existing deployments that still provide `APP_SECRET` will persist it to the key file on the first upgraded startup and can then remove `.env`.

The public port (`3000`) and timezone (`Asia/Shanghai`) are defined directly in `docker-compose.yml`; edit that file when the deployment needs different values.

Useful commands:

```sh
docker compose logs -f
docker compose restart
docker compose down
```

The image serves the built Vue WebUI from `/app/apps/web/dist` through the Hono server. Do not run Vite on the VPS.
