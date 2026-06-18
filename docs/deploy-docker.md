# Docker Deployment

Build and run:

```sh
cp .env.example .env
docker compose up -d --build
```

Open `http://SERVER_IP:3000`, initialize the admin password, then create sources, channels, and rules from the WebUI.

Persistent data lives in `./data` on the host and is mounted at `/data` in the container. The default SQLite database is:

```txt
file:/data/kaname-relay.sqlite
```

Useful commands:

```sh
docker compose logs -f
docker compose restart
docker compose down
```

The image serves the built Vue WebUI from `/app/apps/web/dist` through the Hono server. Do not run Vite on the VPS.
