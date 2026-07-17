import { describe, expect, it } from 'vitest';

import {
  isSupportedSourceType,
  matchesRule,
  parseWebhookSourceEvent,
  renderNotificationMessage,
} from './generic-source.js';
import { validateNotificationTemplate } from './notification-template.js';

describe('generic source match DSL', () => {
  it('matches string prefixes and suffixes without enabling regex', () => {
    const payload = {
      service: 'komari-node-1',
      status: 'disk-full',
    };

    expect(
      matchesRule(
        {
          all: [
            { op: 'starts_with', path: '$.service', value: 'komari-' },
            { op: 'ends_with', path: '$.status', value: '-full' },
          ],
        },
        payload,
      ),
    ).toBe(true);
    expect(matchesRule({ op: 'starts_with', path: '$.service', value: 'wallos-' }, payload)).toBe(
      false,
    );
    expect(matchesRule({ op: 'ends_with', path: '$.status', value: '-ok' }, payload)).toBe(false);
  });

  it('throws for unsupported match operators instead of silently not matching', () => {
    expect(() =>
      matchesRule(
        {
          op: 'regex',
          path: '$.service',
          value: '.*',
        },
        {
          service: 'komari-node-1',
        },
      ),
    ).toThrow('unsupported match op: regex');
  });
});

describe('built-in webhook source parsers', () => {
  it('parses Komari notification-style payloads with hash fallback dedupe', () => {
    const event = parseWebhookSourceEvent({
      sourceType: 'komari',
      payload: {
        title: 'Node down',
        message: 'node-1 is offline',
      },
      config: {},
      payloadHash: 'hash-komari',
    });

    expect(event).toEqual({
      inboundDedupeKey: 'komari:hash-komari',
      eventType: 'komari.notification',
      payload: {
        title: 'Node down',
        message: 'node-1 is offline',
        eventType: 'komari.notification',
      },
    });
  });

  it('does not dedupe Komari manual test notifications', () => {
    const event = parseWebhookSourceEvent({
      sourceType: 'komari',
      payload: {
        title: 'Test',
        message: '',
        dedupeKey: 'Test:',
      },
      config: {},
      payloadHash: 'hash-komari-test',
    });

    expect(event.inboundDedupeKey).toBeNull();
    expect(event.payload).toMatchObject({
      title: 'Test',
      message: '',
      eventType: 'komari.notification',
    });
  });

  it('parses Wallos payloads and honors configured dedupe paths', () => {
    const event = parseWebhookSourceEvent({
      sourceType: 'wallos',
      payload: {
        dedupeKey: 'wallos:netflix:2026-07-01',
        title: 'Subscription due',
        body: 'Netflix renews on 2026-07-01',
      },
      config: {
        inboundDedupePath: '$.dedupeKey',
      },
      payloadHash: 'hash-wallos',
    });

    expect(event).toEqual({
      inboundDedupeKey: 'wallos:netflix:2026-07-01',
      eventType: 'wallos.notification',
      payload: {
        dedupeKey: 'wallos:netflix:2026-07-01',
        title: 'Subscription due',
        body: 'Netflix renews on 2026-07-01',
        message: 'Netflix renews on 2026-07-01',
        eventType: 'wallos.notification',
      },
    });
  });

  it('advertises supported built-in source types', () => {
    expect(isSupportedSourceType('generic')).toBe(true);
    expect(isSupportedSourceType('komari')).toBe(true);
    expect(isSupportedSourceType('wallos')).toBe(true);
    expect(isSupportedSourceType('unknown')).toBe(false);
  });
});

describe('notification rendering fallbacks', () => {
  it('uses a notification title instead of serializing the payload when rendered text is empty', () => {
    expect(
      renderNotificationMessage({
        template: {
          text: '{{payload.message}}',
          title: '{{payload.title}}',
        },
        payload: {
          eventType: 'komari.notification',
          title: 'Test',
          message: '',
        },
        sourceId: 'Komari',
        eventType: 'komari.notification',
        ruleId: 'komari-to-telegram',
        channelId: 'telegram-main',
        now: 1_000,
      }),
    ).toEqual({
      text: 'Test',
      title: 'Test',
    });
  });

  it('keeps JSON as the final fallback for payloads without notification text fields', () => {
    expect(
      renderNotificationMessage({
        template: {},
        payload: {
          count: 3,
        },
        sourceId: 'generic',
        eventType: null,
        ruleId: 'rule-1',
        channelId: 'channel-1',
        now: 1_000,
      }).text,
    ).toBe('{"count":3}');
  });
});

describe('Liquid notification templates', () => {
  it('renders loops, conditions, variables, metadata, and Komari filters', () => {
    const template = {
      engine: 'liquid',
      variables: {
        panelUrl: 'https://status.example.com',
      },
      title: '{{ payload.event | komari_event_name: payload.message }}',
      text: [
        '{% assign info = payload.event | komari_event: payload.message %}',
        '<b>{{ info.title }}</b>',
        '{% for client in payload.clients %}{{ client | country_flag }} {{ client.name | escape }} {{ client.ipv4 | hide_ip }}{% endfor %}',
        '{{ payload.message | komari_translate }}',
        '{{ payload.time | beijing_time: now }}',
      ].join('\n'),
      metadata: {
        telegram: {
          parseMode: 'HTML',
          inlineKeyboard: [
            [
              { text: 'Panel', url: '{{ vars.panelUrl }}' },
              {
                text: 'Instance',
                url: '{% if payload.clients.size == 1 %}{{ vars.panelUrl }}/instance/{{ payload.clients[0].uuid }}{% endif %}',
              },
            ],
          ],
        },
      },
      render: {
        renderer: 'html-image',
        html: '<html><body><h1>{{ payload.event | escape }}</h1></body></html>',
        format: 'png',
        filename: 'komari-{{ payload.event }}.png',
        width: 1200,
        height: 630,
        deviceScaleFactor: 2,
        delivery: 'text-and-image',
      },
    };

    validateNotificationTemplate(template);

    const message = renderNotificationMessage({
      template,
      payload: {
        event: 'offline',
        time: '2026-07-17T12:00:00Z',
        message: 'Client is offline',
        clients: [
          {
            uuid: 'client-1',
            name: 'Tokyo <node>',
            region: '东京',
            ipv4: '192.0.2.10',
          },
        ],
      },
      sourceId: 'komari',
      eventType: 'offline',
      ruleId: 'komari-rich',
      channelId: 'telegram-main',
      now: Date.parse('2026-07-17T12:00:00Z'),
    });

    expect(message.title).toBe('offline');
    expect(message.text).toContain('<b>服务器离线</b>');
    expect(message.text).toContain('🇯🇵 Tokyo &lt;node&gt; 192.0.xxx.xxx');
    expect(message.text).toContain('节点已离线');
    expect(message.text).toContain('2026-07-17 20:00:00');
    expect(message.metadata).toEqual({
      telegram: {
        parseMode: 'HTML',
        inlineKeyboard: [
          [
            { text: 'Panel', url: 'https://status.example.com' },
            {
              text: 'Instance',
              url: 'https://status.example.com/instance/client-1',
            },
          ],
        ],
      },
    });
    expect(message.render).toEqual({
      renderer: 'html-image',
      html: '<html><body><h1>offline</h1></body></html>',
      format: 'png',
      filename: 'komari-offline.png',
      width: 1200,
      height: 630,
      deviceScaleFactor: 2,
      delivery: 'text-and-image',
    });
  });

  it('rejects invalid engines and malformed Liquid at validation time', () => {
    expect(() => validateNotificationTemplate({ engine: 'javascript', text: 'return 1' })).toThrow(
      'unsupported notification template engine',
    );
    expect(() =>
      validateNotificationTemplate({ engine: 'liquid', text: '{% if payload.ok %}' }),
    ).toThrow('notification template error');
  });
});
