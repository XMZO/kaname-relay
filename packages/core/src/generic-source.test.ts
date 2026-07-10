import { describe, expect, it } from 'vitest';

import {
  isSupportedSourceType,
  matchesRule,
  parseWebhookSourceEvent,
  renderNotificationMessage,
} from './generic-source.js';

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
