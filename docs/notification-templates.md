# Notification templates

Kaname rules support two notification template engines:

- `simple` (default): existing `{{payload.path}}` replacement.
- `liquid`: bounded Liquid templates with conditions, loops, variables, and filters.

Existing templates remain compatible. To enable Liquid, set `engine` in the rule's notification template JSON:

```json
{
  "engine": "liquid",
  "variables": {
    "panelUrl": "https://status.example.com"
  },
  "title": "{{ payload.event }}",
  "text": "{% for client in payload.clients %}{{ client.name | escape }}\n{% endfor %}"
}
```

## Context

Liquid templates can read:

- `payload`: the normalized inbound webhook payload.
- `vars`: the template's `variables` object.
- `sourceId`, `eventType`, `ruleId`, and `channelId`.
- `now`: the current Unix timestamp in milliseconds.

Templates are limited by source length, render time, render operations, generated objects, and output length. They cannot access Node.js APIs, the file system, network, environment variables, or object prototypes.

## Komari filters

The built-in Komari preset uses these filters:

- `komari_event`, `komari_event_name`, `komari_event_title`
- `komari_translate`
- `beijing_time`
- `country_flag`
- `format_memory`, `format_traffic`, `traffic_cycle`
- `hide_ip`

The preset accepts Komari's raw event object and formats single-node, multi-node, billing, report, test, offline, online, and recovery notifications.

## Telegram metadata

Templates can provide Telegram presentation options without putting credentials in the template:

```json
{
  "engine": "liquid",
  "text": "<b>{{ payload.title | escape }}</b>",
  "metadata": {
    "telegram": {
      "parseMode": "HTML",
      "disableWebPagePreview": true,
      "inlineKeyboard": [
        [
          {
            "text": "Open panel",
            "url": "{{ vars.panelUrl }}"
          }
        ]
      ]
    }
  }
}
```

Channel configuration overrides metadata when both specify the same Telegram option. Empty button URLs are omitted, which allows conditional buttons in Liquid templates.

## Komari setup

1. Create or edit a `Komari` source in Kaname and apply its source preset.
2. In Komari, create a JavaScript notification sender.
3. Paste the raw-event relay script displayed by Kaname under the source form.
4. Create a rule for that source and apply the Komari rule preset.
5. Change `variables.panelUrl` in the notification template JSON to the real Komari panel URL.
6. Select the Telegram or email channels and preview the rule with the included sample payload.

The relay script sends only fields needed for formatting. In particular, it does not forward the Komari client token.

## Reserved HTML-to-image contract

Kaname reserves a provider-neutral render request in `message_json`, but does not install or run a browser renderer yet:

```json
{
  "engine": "liquid",
  "text": "Daily report is attached.",
  "render": {
    "renderer": "html-image",
    "html": "<!doctype html><html><body><h1>{{ payload.title | escape }}</h1></body></html>",
    "format": "png",
    "filename": "report-{{ now }}.png",
    "width": 1200,
    "height": 1600,
    "deviceScaleFactor": 2,
    "fullPage": true,
    "delivery": "text-and-image"
  }
}
```

The reserved renderer API returns binary assets through `NotifierSendContext.assets`. A future optional renderer can therefore deliver images through Telegram, email attachments, or downstream webhooks without changing the outbox schema or notifier method signature.

Chromium will remain outside the base Kaname image. The intended implementations are an optional local renderer container and a remote renderer adapter. Both must disable page network access by default, enforce time/dimension/output limits, and use inline assets or an explicit allowlist.
