import type { JsonObject } from './types.js';

export interface KomariEventInfo extends JsonObject {
  icon: string;
  level: string;
  name: string;
  title: string;
}

interface KomariEventPresentation {
  icon: string;
  level: string;
  title: string;
}

const COUNTRY_ALIASES: Record<string, string> = {
  中国: 'CN',
  大陆: 'CN',
  北京: 'CN',
  上海: 'CN',
  广州: 'CN',
  深圳: 'CN',
  杭州: 'CN',
  香港: 'HK',
  澳门: 'MO',
  台湾: 'TW',
  美国: 'US',
  洛杉矶: 'US',
  纽约: 'US',
  芝加哥: 'US',
  西雅图: 'US',
  达拉斯: 'US',
  圣何塞: 'US',
  usa: 'US',
  'united states': 'US',
  'los angeles': 'US',
  'new york': 'US',
  chicago: 'US',
  seattle: 'US',
  dallas: 'US',
  'san jose': 'US',
  加拿大: 'CA',
  多伦多: 'CA',
  温哥华: 'CA',
  canada: 'CA',
  toronto: 'CA',
  vancouver: 'CA',
  日本: 'JP',
  东京: 'JP',
  大阪: 'JP',
  japan: 'JP',
  tokyo: 'JP',
  osaka: 'JP',
  韩国: 'KR',
  首尔: 'KR',
  korea: 'KR',
  'south korea': 'KR',
  seoul: 'KR',
  新加坡: 'SG',
  singapore: 'SG',
  德国: 'DE',
  法兰克福: 'DE',
  柏林: 'DE',
  germany: 'DE',
  frankfurt: 'DE',
  berlin: 'DE',
  英国: 'GB',
  伦敦: 'GB',
  'united kingdom': 'GB',
  britain: 'GB',
  london: 'GB',
  法国: 'FR',
  巴黎: 'FR',
  france: 'FR',
  paris: 'FR',
  荷兰: 'NL',
  阿姆斯特丹: 'NL',
  netherlands: 'NL',
  amsterdam: 'NL',
  俄罗斯: 'RU',
  莫斯科: 'RU',
  russia: 'RU',
  moscow: 'RU',
  乌克兰: 'UA',
  ukraine: 'UA',
  澳大利亚: 'AU',
  澳洲: 'AU',
  悉尼: 'AU',
  墨尔本: 'AU',
  australia: 'AU',
  sydney: 'AU',
  melbourne: 'AU',
  新西兰: 'NZ',
  'new zealand': 'NZ',
  印度: 'IN',
  孟买: 'IN',
  德里: 'IN',
  india: 'IN',
  mumbai: 'IN',
  delhi: 'IN',
  泰国: 'TH',
  曼谷: 'TH',
  thailand: 'TH',
  bangkok: 'TH',
  越南: 'VN',
  河内: 'VN',
  胡志明: 'VN',
  vietnam: 'VN',
  hanoi: 'VN',
  马来西亚: 'MY',
  吉隆坡: 'MY',
  malaysia: 'MY',
  菲律宾: 'PH',
  马尼拉: 'PH',
  philippines: 'PH',
  印度尼西亚: 'ID',
  印尼: 'ID',
  雅加达: 'ID',
  indonesia: 'ID',
  土耳其: 'TR',
  伊斯坦布尔: 'TR',
  turkey: 'TR',
  阿联酋: 'AE',
  迪拜: 'AE',
  uae: 'AE',
  dubai: 'AE',
  巴西: 'BR',
  圣保罗: 'BR',
  brazil: 'BR',
  墨西哥: 'MX',
  mexico: 'MX',
  南非: 'ZA',
  'south africa': 'ZA',
  意大利: 'IT',
  米兰: 'IT',
  罗马: 'IT',
  italy: 'IT',
  西班牙: 'ES',
  马德里: 'ES',
  spain: 'ES',
  瑞士: 'CH',
  苏黎世: 'CH',
  switzerland: 'CH',
  瑞典: 'SE',
  挪威: 'NO',
  芬兰: 'FI',
  丹麦: 'DK',
  波兰: 'PL',
  奥地利: 'AT',
  罗马尼亚: 'RO',
  摩尔多瓦: 'MD',
  moldova: 'MD',
  chisinau: 'MD',
  chișinău: 'MD',
};

const EVENT_INFO: Record<string, KomariEventPresentation> = {
  online: { icon: '', title: '服务器上线', level: '正常' },
  offline: { icon: '', title: '服务器离线', level: '异常' },
  alert: { icon: '⚠️', title: '异常警报', level: '警告' },
  renew: { icon: '', title: '续费通知', level: '提醒' },
  expire: { icon: '', title: '到期预警', level: '重要' },
  expired: { icon: '', title: '服务到期', level: '重要' },
  test: { icon: '', title: '测试通知', level: '测试' },
  recover: { icon: '', title: '告警恢复', level: '正常' },
  recovered: { icon: '', title: '告警恢复', level: '正常' },
  report: { icon: '', title: '流量定时报告', level: '报告' },
};

const EXACT_TRANSLATIONS: Record<string, string> = {
  'client is offline': '节点已离线',
  'client is online': '节点已恢复在线',
  'server is offline': '服务器已离线',
  'server is online': '服务器已恢复在线',
  'node is offline': '节点已离线',
  'node is online': '节点已恢复在线',
  'heartbeat timeout': '心跳超时',
  'connection timeout': '连接超时',
  'request timeout': '请求超时',
  'response timeout': '响应超时',
  'ping timeout': 'Ping 超时',
  'no response': '节点无响应',
  'test message': '测试消息',
  'test notification': '测试通知',
  'cpu usage is too high': 'CPU 使用率过高',
  'memory usage is too high': '内存使用率过高',
  'ram usage is too high': '内存使用率过高',
  'disk usage is too high': '磁盘使用率过高',
  'load is too high': '系统负载过高',
  'network error': '网络异常',
  'network unreachable': '网络不可达',
  'connection refused': '连接被拒绝',
  'connection reset': '连接被重置',
  'service expired': '服务已到期',
  'service will expire': '服务即将到期',
  'renew success': '续费成功',
  'renew failed': '续费失败',
};

const TRANSLATION_RULES: Array<[RegExp, string]> = [
  [/\bclient is offline\b/gi, '节点已离线'],
  [/\bclient is online\b/gi, '节点已恢复在线'],
  [/\bserver is offline\b/gi, '服务器已离线'],
  [/\bserver is online\b/gi, '服务器已恢复在线'],
  [/\bnode is offline\b/gi, '节点已离线'],
  [/\bnode is online\b/gi, '节点已恢复在线'],
  [/\bhost is offline\b/gi, '主机已离线'],
  [/\bhost is online\b/gi, '主机已恢复在线'],
  [/\bheartbeat timeout\b/gi, '心跳超时'],
  [/\bconnection timeout\b/gi, '连接超时'],
  [/\brequest timeout\b/gi, '请求超时'],
  [/\bresponse timeout\b/gi, '响应超时'],
  [/\bping timeout\b/gi, 'Ping 超时'],
  [/\bcpu usage is too high\b/gi, 'CPU 使用率过高'],
  [/\bmemory usage is too high\b/gi, '内存使用率过高'],
  [/\bram usage is too high\b/gi, '内存使用率过高'],
  [/\bdisk usage is too high\b/gi, '磁盘使用率过高'],
  [/\bload is too high\b/gi, '系统负载过高'],
  [/\bnetwork unreachable\b/gi, '网络不可达'],
  [/\bnetwork error\b/gi, '网络异常'],
  [/\bconnection refused\b/gi, '连接被拒绝'],
  [/\bconnection reset\b/gi, '连接被重置'],
  [/\bno response\b/gi, '节点无响应'],
  [/\boffline\b/gi, '离线'],
  [/\bonline\b/gi, '在线'],
  [/\bdown\b/gi, '不可用'],
  [/\bup\b/gi, '可用'],
  [/\balert\b/gi, '告警'],
  [/\bwarning\b/gi, '警告'],
  [/\bcritical\b/gi, '严重'],
  [/\berror\b/gi, '错误'],
  [/\bfailed\b/gi, '失败'],
  [/\bfailure\b/gi, '故障'],
  [/\bsuccess\b/gi, '成功'],
  [/\btimeout\b/gi, '超时'],
  [/\bheartbeat\b/gi, '心跳'],
  [/\bconnection\b/gi, '连接'],
  [/\bconnect\b/gi, '连接'],
  [/\bdisconnect\b/gi, '断开连接'],
  [/\brequest\b/gi, '请求'],
  [/\bresponse\b/gi, '响应'],
  [/\bserver\b/gi, '服务器'],
  [/\bclient\b/gi, '节点'],
  [/\bnode\b/gi, '节点'],
  [/\bhost\b/gi, '主机'],
  [/\bcpu\b/gi, 'CPU'],
  [/\bmemory\b/gi, '内存'],
  [/\bram\b/gi, '内存'],
  [/\bdisk\b/gi, '磁盘'],
  [/\bload\b/gi, '负载'],
  [/\btraffic\b/gi, '流量'],
  [/\bnetwork\b/gi, '网络'],
  [/\bupload\b/gi, '上传'],
  [/\bdownload\b/gi, '下载'],
  [/\busage\b/gi, '使用率'],
  [/\bhigh\b/gi, '过高'],
  [/\blow\b/gi, '过低'],
  [/\brenew\b/gi, '续费'],
  [/\bexpire\b/gi, '到期'],
  [/\bexpired\b/gi, '已到期'],
  [/\btest\b/gi, '测试'],
  [/\bmessage\b/gi, '消息'],
  [/\bnotification\b/gi, '通知'],
];

export function normalizeKomariEventName(event: unknown, message?: unknown): string {
  const raw = stringValue(event).toLowerCase();
  const detail = stringValue(message);

  if (
    raw === 'wreport' ||
    raw === 'mreport' ||
    raw.includes('report') ||
    detail.includes('流量报告')
  ) {
    return 'report';
  }

  return raw || 'notification';
}

export function komariEventInfo(event: unknown, message?: unknown): KomariEventInfo {
  const name = normalizeKomariEventName(event, message);
  const info = EVENT_INFO[name] ?? { icon: '', title: '系统通知', level: '通知' };
  return { name, ...info };
}

export function translateKomariMessage(value: unknown): string {
  let message = stringValue(value).trim();
  if (!message) return '';

  const exact = EXACT_TRANSLATIONS[message.toLowerCase()];
  if (exact) return exact;

  for (const [pattern, replacement] of TRANSLATION_RULES) {
    message = message.replace(pattern, replacement);
  }
  return message;
}

export function formatBeijingTime(value: unknown, fallbackNow?: unknown): string {
  const raw = stringValue(value);
  const fallback = finiteNumber(fallbackNow) ?? Date.now();
  const parsed =
    !raw || raw.startsWith('0001') ? fallback : Date.parse(raw.replace(/\.\d+Z$/, 'Z'));
  const date = new Date(Number.isFinite(parsed) ? parsed : fallback);
  const cst = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${cst.getUTCFullYear()}-${pad(cst.getUTCMonth() + 1)}-${pad(cst.getUTCDate())} ${pad(cst.getUTCHours())}:${pad(cst.getUTCMinutes())}:${pad(cst.getUTCSeconds())}`;
}

export function formatMemory(value: unknown): string {
  const bytes = finiteNumber(value) ?? 0;
  if (bytes <= 0) return '0';
  const gib = bytes / 1024 ** 3;
  return gib < 1 ? `${Math.round(gib * 1024)}MB` : `${Math.round(gib)}G`;
}

export function formatTraffic(value: unknown): string {
  const bytes = finiteNumber(value) ?? 0;
  if (bytes <= 0) return '无限制';
  const gib = bytes / 1024 ** 3;
  return gib >= 1024 ? `${(gib / 1024).toFixed(2)} TB` : `${gib.toFixed(2)} GB`;
}

export function trafficCycle(value: unknown): string {
  const type = stringValue(value).toLowerCase().trim();
  const labels: Record<string, string> = {
    sum: '（总和）',
    max: '（取最大）',
    min: '（取最小）',
    upload: '（仅上传）',
    up: '（仅上传）',
    download: '（仅下载）',
    down: '（仅下载）',
  };
  return type ? (labels[type] ?? `（${type}）`) : '';
}

export function hideIp(value: unknown): string {
  const ip = stringValue(value);
  if (!ip) return '未知';
  const ipv4 = ip.split('.');
  if (ipv4.length === 4) return `${ipv4[0]}.${ipv4[1]}.xxx.xxx`;
  return `${ip.split(':').slice(0, 3).join(':')}:xxxx:xxxx:xxxx`;
}

export function countryFlag(value: unknown): string {
  if (!isObject(value)) return '';

  const existing = [value.region, value.name].map(stringValue).join(' ');
  if (/\p{Regional_Indicator}{2}/u.test(existing)) return '';

  const directFields = [
    value.country_code,
    value.countryCode,
    value.region_code,
    value.regionCode,
    value.iso2,
    value.cc,
  ];
  for (const field of directFields) {
    const code = validCountryCode(field);
    if (code) return countryCodeToFlag(code);
  }

  const searchable = [
    value.name,
    value.region,
    value.country,
    value.location,
    value.remark,
    value.description,
    value.hostname,
    value.host,
  ]
    .map(stringValue)
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  for (const [alias, code] of Object.entries(COUNTRY_ALIASES)) {
    if (searchable.includes(alias.toLowerCase())) return countryCodeToFlag(code);
  }

  for (const token of searchable
    .toUpperCase()
    .split(/[^A-Z]/)
    .filter(Boolean)) {
    const code = validCountryCode(token);
    if (code) return countryCodeToFlag(code);
  }
  return '';
}

function countryCodeToFlag(code: string): string {
  return [...code]
    .map((character) => String.fromCodePoint(127397 + character.charCodeAt(0)))
    .join('');
}

function validCountryCode(value: unknown): string | null {
  const code = stringValue(value).trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string'
    ? value
    : value === null || value === undefined
      ? ''
      : String(value);
}

function finiteNumber(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
