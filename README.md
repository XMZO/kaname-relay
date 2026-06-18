# Kaname Relay

Lightweight webhook relay with WebUI management, outbox-based reliable delivery, SQLite/D1 storage, and Node.js plus Cloudflare Worker runtimes.

## Features

- Receive webhooks, match rules, render messages, and deliver through notifiers.
- Built-in source parsers: `generic`, `komari`, `wallos`.
- Notifiers: Telegram, Resend email, and Node-only SMTP.
- At-least-once delivery with lease recovery, exponential backoff, sent-log dedupe, and dead-letter states.
- WebUI for sources, channels, rules, outbox, sent log, test sends, replay, and cancel.
- Secret encryption with `APP_SECRET` / `KANAME_APP_SECRET`; plaintext secrets remain readable for migration.

## Local VPS / Docker

```bash
pnpm install
pnpm run build
APP_SECRET='replace-with-32-random-chars' pnpm --filter @kaname-relay/server start
```

Docker Compose uses the same runtime. Keep `APP_SECRET` stable; changing it makes encrypted secrets unreadable unless they are rotated.

Important environment variables:

- `APP_SECRET` or `KANAME_APP_SECRET`: enables AES-GCM encryption for source/channel secrets.
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

- Restore by stopping the server, replacing the SQLite file, then starting again with the same `APP_SECRET`.
- D1 backup/export should be done with Wrangler D1 export for the target Cloudflare account.

## Examples

See [docs/examples/m5-komari-wallos-email.md](docs/examples/m5-komari-wallos-email.md) for Komari, Wallos, Resend, and SMTP examples.
