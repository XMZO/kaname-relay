import type { JsonObject } from './types.js';

export const KOMARI_SOURCE_CONFIG: JsonObject = {
  defaultEventType: 'komari.notification',
  eventTypePath: '$.event',
  inboundDedupePath: '$.dedupeKey',
};

export const KOMARI_RULE_MATCH: JsonObject = {
  not: {
    op: 'eq',
    path: '$.event',
    value: 'dreport',
  },
};

export const KOMARI_RICH_TEXT_TEMPLATE = `{% assign event_name = payload.event | komari_event_name: payload.message %}{% assign info = event_name | komari_event: payload.message %}<b>{% if info.icon != blank %}{{ info.icon }} {% endif %}{{ info.title }}</b>

{% assign client_count = payload.clients | size %}{% if client_count == 1 %}{% assign client = payload.clients | first %}{% assign flag = client | country_flag %}<b>服务器：</b>{% if flag != blank %}{{ flag }} {% endif %}{{ client.name | default: '未知节点' | escape }}{% if client.region != blank %} [{{ client.region | escape }}]{% endif %}
{% assign swap = client.swap_total | format_memory %}<b>配 置：</b>{{ client.cpu_cores | default: 0 }}C / {{ client.mem_total | format_memory }}{% if swap != '0' %}+{{ swap }}{% endif %} / {{ client.disk_total | format_memory }}
<b>IPv4：</b><code>{{ client.ipv4 | hide_ip | escape }}</code>
<b>IPv6：</b><code>{{ client.ipv6 | hide_ip | escape }}</code>
<b>流量限额：</b>{{ client.traffic_limit | format_traffic }}{% if client.traffic_limit > 0 %}{{ client.traffic_limit_type | traffic_cycle }}{% endif %}
{% if event_name == 'renew' or event_name == 'expire' or event_name == 'expired' %}<b>账 单：</b>{{ client.currency | default: '$' | escape }}{{ client.price | default: 0 }} ({{ client.billing_cycle | default: 0 }}天/付)
{% endif %}{% elsif client_count > 1 %}
<b>关联节点：</b>{{ client_count }} 台

{% for client in payload.clients %}{% assign flag = client | country_flag %}{{ forloop.index }}. {% if flag != blank %}{{ flag }} {% endif %}<b>{{ client.name | default: '未知节点' | escape }}</b>{% if client.region != blank %} ｜ {{ client.region | escape }}{% endif %}
{% endfor %}{% elsif event_name != 'report' %}
<b>服务器：</b>全局系统级事件
{% endif %}<b>事件级别：</b>{{ info.level }}
<b>北京时间：</b>{{ payload.time | beijing_time: now }}
{% assign detail = payload.message | komari_translate %}{% if detail != blank %}

<b>详细描述：</b>
{{ detail | escape }}{% endif %}`;

export const KOMARI_NOTIFICATION_TEMPLATE: JsonObject = {
  engine: 'liquid',
  variables: {
    panelUrl: 'https://komari.example.com',
  },
  title: '{{ payload.event | komari_event_title: payload.message }}',
  text: KOMARI_RICH_TEXT_TEMPLATE,
  metadata: {
    telegram: {
      parseMode: 'HTML',
      disableWebPagePreview: true,
      inlineKeyboard: [
        [
          {
            text: '进入面板',
            url: '{{ vars.panelUrl }}',
          },
          {
            text: '实例详情',
            url: '{% if payload.clients.size == 1 %}{{ vars.panelUrl }}/instance/{{ payload.clients[0].uuid }}{% endif %}',
          },
        ],
      ],
    },
  },
};

export const KOMARI_SAMPLE_PAYLOAD: JsonObject = {
  event: 'offline',
  time: '2026-07-17T12:00:00Z',
  message: 'Client is offline',
  emoji: '',
  dedupeKey: 'komari:offline:2026-07-17T12:00:00Z:client-1',
  clients: [
    {
      uuid: 'client-1',
      name: 'Tokyo Node',
      cpu_cores: 2,
      ipv4: '192.0.2.10',
      ipv6: '2001:db8::10',
      region: '东京',
      mem_total: 2_147_483_648,
      swap_total: 536_870_912,
      disk_total: 42_949_672_960,
      traffic_limit: 1_073_741_824_000,
      traffic_limit_type: 'max',
      currency: '$',
      price: 5,
      billing_cycle: 30,
    },
  ],
};

export function createKomariRelayScript(endpoint: string): string {
  return [
    `const KANAME_WEBHOOK_URL = ${JSON.stringify(endpoint)};`,
    '',
    'function safeClient(client) {',
    '  return {',
    '    uuid: client.uuid,',
    '    name: client.name,',
    '    cpu_cores: client.cpu_cores,',
    '    ipv4: client.ipv4,',
    '    ipv6: client.ipv6,',
    '    region: client.region,',
    '    remark: client.remark,',
    '    mem_total: client.mem_total,',
    '    swap_total: client.swap_total,',
    '    disk_total: client.disk_total,',
    '    traffic_limit: client.traffic_limit,',
    '    traffic_limit_type: client.traffic_limit_type,',
    '    currency: client.currency,',
    '    price: client.price,',
    '    billing_cycle: client.billing_cycle,',
    '  };',
    '}',
    '',
    'async function sendEvent(event) {',
    '  const clients = Array.isArray(event.clients) ? event.clients.map(safeClient) : [];',
    '  const eventName = String(event.event || "notification").toLowerCase();',
    '  const eventTime = String(event.time || "");',
    '  const clientKey = clients.map((client) => client.uuid || client.name || "unknown").sort().join(",") || "global";',
    '',
    '  const response = await fetch(KANAME_WEBHOOK_URL, {',
    '    method: "POST",',
    '    headers: { "Content-Type": "application/json" },',
    '    body: JSON.stringify({',
    '      event: eventName,',
    '      time: eventTime,',
    '      message: String(event.message || ""),',
    '      emoji: String(event.emoji || ""),',
    '      clients,',
    '      dedupeKey: `komari:${eventName}:${eventTime}:${clientKey}`,',
    '    }),',
    '  });',
    '',
    '  if (!response.ok) console.log(`Kaname webhook failed: ${response.status}`);',
    '  return response.ok;',
    '}',
  ].join('\n');
}
