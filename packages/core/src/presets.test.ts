import { describe, expect, it } from 'vitest';

import { renderNotificationMessage } from './generic-source.js';
import { validateNotificationTemplate } from './notification-template.js';
import {
  createKomariRelayScript,
  KOMARI_NOTIFICATION_TEMPLATE,
  KOMARI_SAMPLE_PAYLOAD,
} from './presets.js';

describe('Komari notification preset', () => {
  it('validates and renders the shared rich notification template', () => {
    validateNotificationTemplate(KOMARI_NOTIFICATION_TEMPLATE);

    const message = renderNotificationMessage({
      template: KOMARI_NOTIFICATION_TEMPLATE,
      payload: KOMARI_SAMPLE_PAYLOAD,
      sourceId: 'komari',
      eventType: 'offline',
      ruleId: 'komari-rich',
      channelId: 'telegram-main',
      now: Date.parse('2026-07-17T12:00:00Z'),
    });

    expect(message.title).toBe('服务器离线');
    expect(message.text).toContain('<b>服务器离线</b>');
    expect(message.text).toContain('🇯🇵 Tokyo Node [东京]');
    expect(message.text).toContain('<code>192.0.xxx.xxx</code>');
    expect(message.text).toContain('2C / 2G+512MB / 40G');
    expect(message.text).toContain('节点已离线');
    expect(message.metadata).toEqual({
      telegram: {
        parseMode: 'HTML',
        disableWebPagePreview: true,
        inlineKeyboard: [
          [
            { text: '进入面板', url: 'https://komari.example.com' },
            {
              text: '实例详情',
              url: 'https://komari.example.com/instance/client-1',
            },
          ],
        ],
      },
    });
  });

  it('generates a raw-event relay without forwarding Komari client tokens', () => {
    const script = createKomariRelayScript('https://relay.example.com/hooks/komari');

    expect(script).toContain('async function sendEvent(event)');
    expect(script).toContain('https://relay.example.com/hooks/komari');
    expect(script).toContain('dedupeKey: `komari:${eventName}:${eventTime}:${clientKey}`');
    expect(script).not.toContain('client.token');
  });
});
