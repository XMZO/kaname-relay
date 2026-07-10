# Kaname Relay

Lightweight webhook relay with WebUI management, outbox-based reliable delivery, SQLite/D1 storage, and Node.js plus Cloudflare Worker runtimes.

## Features

- Receive webhooks, match rules, render messages, and deliver through notifiers.
- Built-in source parsers: `generic`, `komari`, `wallos`.
- Notifiers: Telegram, generic webhook, Resend email, and Node-only SMTP.
- At-least-once delivery with lease recovery, exponential backoff, sent-log dedupe, and dead-letter states.
- WebUI for sources, channels, rules, outbox, sent log, test sends, replay, and cancel.
- Notification channel credentials are configured in the WebUI channel forms, not via provider-specific `.env` variables.
- Secret encryption with an automatically persisted runtime key; `APP_SECRET` remains an optional override for existing deployments.

## Local VPS / Docker

```bash
pnpm install
pnpm run build
pnpm --filter @kaname-relay/server start
```

Docker Compose requires no `.env` file. The image, port, timezone, database path, and static asset paths are defined in `docker-compose.yml`. On first start, the server creates `.kaname-app-secret` beside the SQLite database and reuses it on later starts.

Optional runtime overrides:

- `APP_SECRET` or `KANAME_APP_SECRET`: overrides the generated AES-GCM key. When no key file exists, the override is persisted for migration away from `.env`.
- `KANAME_APP_SECRET_FILE`: overrides the generated key file path.
- `KANAME_SQLITE_PATH` or `DATABASE_URL`: SQLite file path. Defaults to `data/kaname-relay.sqlite`.
- `KANAME_WEB_DIR`: static WebUI directory. Set to `disabled` to disable static serving.
- `PORT` / `HOST`: Node server bind address.

## Cloudflare Worker / D1

```bash
pnpm --filter @kaname-relay/web build
pnpm exec wrangler d1 migrations apply kaname-relay --config apps/worker/wrangler.toml
pnpm exec wrangler secret put APP_SECRET --config apps/worker/wrangler.toml
pnpm --filter @kaname-relay/worker build
pnpm exec wrangler deploy --config apps/worker/wrangler.toml
```

Worker webhook delivery is bounded: `ctx.waitUntil()` handles a small immediate batch, and Cron handles backlog/retry at one-minute granularity.

## Security Notes

- Configure `webhookSecret` in source secrets to require `x-kaname-signature: sha256=<hmac>` over the raw request body.
- WebUI admin APIs use HttpOnly session cookies plus a double-submit CSRF token.
- Default webhook rate limit is 120 requests per source/client IP/minute.
- Secrets are never returned by the API; only `hasSecret` is shown.

## Retention And Backup

- Default cleanup keeps sent/cancelled outbox and sent_log for 30 days, deleting at most 100 rows per pass.
- Dead outbox rows are retained until manually replayed/cancelled/cleaned.
- SQLite backup:

```bash
sqlite3 data/kaname-relay.sqlite ".backup 'kaname-relay-backup.sqlite'"
```

- Back up `data/.kaname-app-secret` together with SQLite. Restore both files before starting the server.
- D1 backup/export should be done with Wrangler D1 export for the target Cloudflare account.

## Examples

See [docs/examples/m5-komari-wallos-email.md](docs/examples/m5-komari-wallos-email.md) for Komari, Wallos, Resend, and SMTP examples.
