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

## Resend Channel

Channel:

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

SMTP is Node/VPS-only and is not included in the Cloudflare Worker bundle.

```json
{
  "type": "smtp",
  "config": {
    "host": "smtp.example.com",
    "port": 587,
    "secure": false,
    "from": "alerts@example.com",
    "to": "ops@example.com"
  },
  "secrets": {
    "user": "smtp-user",
    "pass": "smtp-password"
  }
}
```
