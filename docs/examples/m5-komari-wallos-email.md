# M5 Source And Email Examples

## Komari

Source:

```json
{
  "type": "komari",
  "config": {
    "defaultEventType": "komari.notification"
  }
}
```

Recommended Komari webhook JSON body:

```json
{
  "title": "{{title}}",
  "message": "{{message}}",
  "dedupeKey": "{{title}}:{{message}}"
}
```

Rule match:

```json
{
  "op": "eq",
  "path": "$.eventType",
  "value": "komari.notification"
}
```

Rule template:

```json
{
  "title": "Komari",
  "text": "{{payload.title}}\n{{payload.message}}"
}
```

## Wallos

Source:

```json
{
  "type": "wallos",
  "config": {
    "defaultEventType": "wallos.notification",
    "inboundDedupePath": "$.dedupeKey"
  }
}
```

Recommended Wallos webhook JSON body:

```json
{
  "title": "Subscription due",
  "body": "Netflix renews on 2026-07-01",
  "dedupeKey": "wallos:netflix:2026-07-01"
}
```

Rule match:

```json
{
  "op": "eq",
  "path": "$.eventType",
  "value": "wallos.notification"
}
```

Rule template:

```json
{
  "title": "Wallos",
  "text": "{{payload.title}}\n{{payload.message}}"
}
```

## Webhook Channel

Generic webhook channels send the rendered notification message as JSON over `fetch`. Config headers are non-secret; secret headers are encrypted and never returned by the API.

```json
{
  "type": "webhook",
  "config": {
    "url": "https://example.com/hooks/notify",
    "headers": {
      "x-route": "ops"
    },
    "idempotencyHeader": "Idempotency-Key"
  },
  "secrets": {
    "headers": {
      "authorization": "Bearer token"
    }
  }
}
```

## Resend Channel

Create this from the WebUI: Channels -> Type `Resend email`. The JSON below mirrors what the form stores; it is not an `.env` file.

```json
{
  "type": "resend",
  "config": {
    "from": "Kaname <alerts@example.com>",
    "to": ["ops@example.com"]
  },
  "secrets": {
    "apiKey": "re_..."
  }
}
```

## SMTP Channel

SMTP is Node/VPS-only and is not included in the Cloudflare Worker bundle. Create this from the WebUI: Channels -> Type `SMTP email`. The host, port, SSL/STARTTLS, LOGIN auth, username, and password/app password are all WebUI fields stored in the channel config/secret bundle; no SMTP `.env` variables are required.

```json
{
  "type": "smtp",
  "config": {
    "host": "smtp.example.com",
    "port": 587,
    "use_ssl": true,
    "use_login_auth": false,
    "from": "alerts@example.com",
    "to": "ops@example.com"
  },
  "secrets": {
    "user": "smtp-user",
    "pass": "smtp-password"
  }
}
```

For Outlook/Office365 SMTP, use `smtp.office365.com`, port `587`, and set `use_login_auth` to `true`. The `use_ssl: true` + `port: 587` combination uses STARTTLS, matching Komari's SMTP behavior.
