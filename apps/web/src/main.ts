import { computed, createApp, onMounted, reactive, ref } from 'vue';

import { defaultLocale, isLocale, messages, type Locale } from './i18n';
import './styles.css';

type JsonRecord = Record<string, unknown>;

const sourceTypes = ['generic', 'komari', 'wallos'] as const;
type SourceType = (typeof sourceTypes)[number];

interface SourceTypePreset {
  config: JsonRecord;
  match: JsonRecord;
  template: JsonRecord;
  samplePayload: JsonRecord;
}

const sourceTypePresets: Record<SourceType, SourceTypePreset> = {
  generic: {
    config: {
      inboundDedupePath: '$.id',
      eventTypePath: '$.eventType',
    },
    match: {
      op: 'eq',
      path: '$.eventType',
      value: 'demo',
    },
    template: {
      text: 'Hello {{payload.name}}',
      title: '{{eventType}}',
    },
    samplePayload: {
      id: 'evt-1',
      eventType: 'demo',
      name: 'Ada',
    },
  },
  komari: {
    config: {
      defaultEventType: 'komari.notification',
    },
    match: {},
    template: {
      text: '{{payload.message}}',
      title: '{{payload.title}}',
    },
    samplePayload: {
      title: 'Node down',
      message: 'node-1 is offline',
    },
  },
  wallos: {
    config: {
      defaultEventType: 'wallos.notification',
      inboundDedupePath: '$.dedupeKey',
    },
    match: {},
    template: {
      text: '{{payload.message}}',
      title: '{{payload.title}}',
    },
    samplePayload: {
      eventType: 'wallos.payment_due',
      title: 'Netflix',
      message: 'Netflix renews in 5 days for 10.00 USD',
      dedupeKey: 'wallos:payment:netflix:2026-07-15:5',
      subscriptionName: 'Netflix',
      price: '10.00',
      currency: 'USD',
      date: '2026-07-15',
      daysUntil: '5',
    },
  },
};

const komariWebhookBody = {
  title: '{{title}}',
  message: '{{message}}',
};

const wallosPaymentWebhookBody = {
  eventType: 'wallos.payment_due',
  title: '{{subscription_name}}',
  message:
    '{{subscription_name}} renews in {{days_until}} days for {{subscription_price}} {{subscription_currency}}',
  dedupeKey: 'wallos:payment:{{subscription_name}}:{{subscription_date}}:{{days_until}}',
  subscriptionName: '{{subscription_name}}',
  price: '{{subscription_price}}',
  currency: '{{subscription_currency}}',
  category: '{{subscription_category}}',
  date: '{{subscription_date}}',
  payer: '{{subscription_payer}}',
  daysUntil: '{{days_until}}',
  billingCycleDays: '{{subscription_days_until_payment}}',
  notes: '{{subscription_notes}}',
  url: '{{subscription_url}}',
};

const wallosCancellationWebhookBody = {
  eventType: 'wallos.cancellation',
  title: '{{subscription_name}} cancellation',
  message: '{{subscription_name}} is scheduled for cancellation on {{subscription_date}}',
  dedupeKey: 'wallos:cancellation:{{subscription_name}}:{{subscription_date}}',
  subscriptionName: '{{subscription_name}}',
  price: '{{subscription_price}}',
  currency: '{{subscription_currency}}',
  category: '{{subscription_category}}',
  date: '{{subscription_date}}',
  payer: '{{subscription_payer}}',
  notes: '{{subscription_notes}}',
  url: '{{subscription_url}}',
};

const channelTypes = ['telegram', 'resend', 'smtp', 'webhook'] as const;
type ChannelType = (typeof channelTypes)[number];
type TriStateBoolean = '' | 'true' | 'false';

interface ChannelTypePreset {
  config: JsonRecord;
  secrets: JsonRecord;
}

interface ChannelFields {
  telegramChatId: string;
  telegramParseMode: string;
  telegramDisableWebPagePreview: TriStateBoolean;
  telegramBotToken: string;
  resendFrom: string;
  resendTo: string;
  resendSubject: string;
  resendReplyTo: string;
  resendEndpoint: string;
  resendApiKey: string;
  smtpHost: string;
  smtpPort: number;
  smtpUseSsl: boolean;
  smtpUseLoginAuth: boolean;
  smtpFrom: string;
  smtpTo: string;
  smtpSubject: string;
  smtpUser: string;
  smtpPass: string;
  webhookUrl: string;
  webhookMethod: string;
  webhookHeadersText: string;
  webhookIdempotencyHeader: string;
  webhookSecretHeadersText: string;
}

interface ChannelFormState {
  id: string;
  name: string;
  type: ChannelType;
  enabled: boolean;
  configText: string;
  secretsText: string;
  testText: string;
  fields: ChannelFields;
}

const channelTypePresets: Record<ChannelType, ChannelTypePreset> = {
  telegram: {
    config: {
      chatId: '',
    },
    secrets: {
      botToken: '',
    },
  },
  resend: {
    config: {
      from: '',
      to: '',
      subject: 'Kaname Relay notification',
    },
    secrets: {
      apiKey: '',
    },
  },
  smtp: {
    config: {
      host: '',
      port: 587,
      use_ssl: true,
      use_login_auth: false,
      from: '',
      to: '',
      subject: 'Kaname Relay notification',
    },
    secrets: {
      user: '',
      pass: '',
    },
  },
  webhook: {
    config: {
      url: '',
      method: 'POST',
      headers: {},
      idempotencyHeader: 'Idempotency-Key',
    },
    secrets: {
      headers: {},
    },
  },
};

interface SourceRow {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  config: JsonRecord;
  hasSecret: boolean;
  webhookPath: string;
  lastEventAt: number | null;
  lastEventType: string | null;
  lastEventDedupeKey: string | null;
  lastEventSeenCount: number | null;
}

interface ChannelRow {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  config: JsonRecord;
  hasSecret: boolean;
}

interface RuleRow {
  id: string;
  sourceId: string | null;
  name: string;
  enabled: boolean;
  priority: number;
  match: JsonRecord;
  template: JsonRecord;
  stopOnMatch: boolean;
  channelIds: string[];
}

interface OutboxRow {
  id: string;
  sourceId: string;
  channelId: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  nextAt: number;
  lastError: string | null;
  messageJson: string;
  payloadJson: string;
}

interface SentLogRow {
  id: string;
  outboxId: string | null;
  outboundDedupeKey: string | null;
  channelId: string;
  notifierType: string;
  providerMessageId: string | null;
  sentAt: number;
}

interface SettingsResponse {
  retention: JsonRecord;
  retry: JsonRecord;
}

const tabs = [
  'dashboard',
  'sources',
  'channels',
  'rules',
  'outbox',
  'sent-log',
  'settings',
] as const;
type Tab = (typeof tabs)[number];
type StatusKey = keyof (typeof messages)[Locale]['status'];

const languageStorageKey = 'kaname-relay-language';
const activeTabStorageKey = 'kaname-relay-active-tab';

const app = createApp({
  setup() {
    const locale = ref<Locale>(initialLocale());
    const t = computed(() => messages[locale.value]);
    const state = reactive({
      initialized: false,
      authenticated: false,
      password: '',
      activeTab: initialTab(),
      loading: false,
      notice: '',
      error: '',
      dashboard: {
        receivedLast24h: 0,
        outboxByStatus: {
          pending: 0,
          sending: 0,
          sent: 0,
          dead: 0,
          cancelled: 0,
        },
        recentErrors: [] as OutboxRow[],
      },
      sources: [] as SourceRow[],
      channels: [] as ChannelRow[],
      rules: [] as RuleRow[],
      outbox: [] as OutboxRow[],
      sentLog: [] as SentLogRow[],
      selectedOutbox: null as OutboxRow | null,
      outboxStatus: '',
      outboxSourceId: '',
      outboxChannelId: '',
      outboxCreatedFrom: '',
      outboxCreatedTo: '',
      previewResult: '',
      sourceForm: {
        id: '',
        name: '',
        type: 'generic',
        enabled: true,
        configText: pretty(sourceTypePresets.generic.config),
        secretsText: '{}',
      },
      channelForm: createChannelForm(),
      ruleForm: {
        id: '',
        sourceId: '',
        name: '',
        enabled: true,
        priority: 0,
        stopOnMatch: false,
        matchText: pretty(sourceTypePresets.generic.match),
        templateText: pretty(sourceTypePresets.generic.template),
        channelIdsText: '',
        samplePayloadText: pretty(sourceTypePresets.generic.samplePayload),
      },
      settingsForm: {
        retentionText: '{}',
        retryText: '{}',
        currentPassword: '',
        newPassword: '',
      },
    });

    async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
      const headers = new Headers(init.headers);

      if (init.body !== undefined && !headers.has('content-type')) {
        headers.set('content-type', 'application/json');
      }

      if (isMutatingRequest(init.method) && !headers.has('x-kaname-csrf')) {
        const csrf = cookieValue('kaname_csrf');

        if (csrf) {
          headers.set('x-kaname-csrf', csrf);
        }
      }

      const response = await fetch(path, {
        ...init,
        headers,
        credentials: 'include',
      });
      const text = await response.text();
      const payload = text.length > 0 ? (JSON.parse(text) as JsonRecord) : {};

      if (!response.ok) {
        throw new Error(typeof payload.error === 'string' ? payload.error : response.statusText);
      }

      return payload as T;
    }

    async function run(task: () => Promise<void>, success = ''): Promise<void> {
      state.loading = true;
      state.error = '';
      state.notice = '';

      try {
        await task();
        state.notice = success;
      } catch (error) {
        state.error = localizeError(error);
      } finally {
        state.loading = false;
      }
    }

    function localizeError(error: unknown): string {
      if (!(error instanceof Error)) {
        return t.value.messages.requestFailed;
      }

      if (error.message === 'JSON must be an object') {
        return t.value.messages.jsonMustBeObject;
      }

      if (error.message.startsWith('unknown source ID:')) {
        return `${t.value.messages.unknownSourceId}: ${error.message.slice('unknown source ID:'.length).trim()}`;
      }

      if (error.message.startsWith('source ID already exists:')) {
        return `${t.value.messages.sourceIdAlreadyExists}: ${error.message.slice('source ID already exists:'.length).trim()}`;
      }

      if (error.message.startsWith('unknown channel IDs:')) {
        return `${t.value.messages.unknownChannelIds}: ${error.message.slice('unknown channel IDs:'.length).trim()}`;
      }

      return error.message;
    }

    async function refreshStatus(): Promise<void> {
      const status = await request<{ initialized: boolean; authenticated: boolean }>(
        '/api/auth/status',
      );
      state.initialized = status.initialized;
      state.authenticated = status.authenticated;

      if (status.authenticated) {
        await loadTab(state.activeTab);
      }
    }

    async function submitAuth(): Promise<void> {
      await run(async () => {
        await request(state.initialized ? '/api/auth/login' : '/api/auth/init', {
          method: 'POST',
          body: JSON.stringify({
            password: state.password,
          }),
        });
        state.password = '';
        await refreshStatus();
      });
    }

    async function logout(): Promise<void> {
      await run(async () => {
        await request('/api/auth/logout', { method: 'POST' });
        state.authenticated = false;
      });
    }

    async function setTab(tab: Tab): Promise<void> {
      state.activeTab = tab;

      try {
        sessionStorage.setItem(activeTabStorageKey, tab);
      } catch {
        // Navigation still works when storage is unavailable.
      }

      await loadTab(tab);
    }

    async function refreshCurrentTab(): Promise<void> {
      await run(async () => loadTab(state.activeTab));
    }

    async function loadTab(tab: Tab): Promise<void> {
      if (!state.authenticated) {
        return;
      }

      if (tab === 'dashboard') {
        await loadDashboard();
      } else if (tab === 'sources') {
        await loadSources();
      } else if (tab === 'channels') {
        await loadChannels();
      } else if (tab === 'rules') {
        await Promise.all([loadSources(), loadChannels(), loadRules()]);
      } else if (tab === 'outbox') {
        await loadOutbox();
      } else if (tab === 'sent-log') {
        await loadSentLog();
      } else if (tab === 'settings') {
        await loadSettings();
      }
    }

    async function loadDashboard(): Promise<void> {
      const data = await request<typeof state.dashboard>('/api/admin/dashboard');
      state.dashboard = data;
    }

    async function loadSources(): Promise<void> {
      const data = await request<{ sources: SourceRow[] }>('/api/admin/sources');
      state.sources = data.sources;
    }

    async function saveSource(): Promise<void> {
      await run(async () => {
        const data = await request<{ source: SourceRow }>('/api/admin/sources', {
          method: 'POST',
          body: JSON.stringify({
            id: optionalText(state.sourceForm.id),
            name: state.sourceForm.name,
            type: state.sourceForm.type,
            enabled: state.sourceForm.enabled,
            config: parseJsonObject(state.sourceForm.configText),
            secrets: parseJsonObject(state.sourceForm.secretsText),
          }),
        });
        editSource(data.source);
        await loadSources();
      }, t.value.messages.sourceSaved);
    }

    function editSource(source: SourceRow): void {
      state.sourceForm = {
        id: source.id,
        name: source.name,
        type: sourceTypeOrDefault(source.type),
        enabled: source.enabled,
        configText: pretty(source.config),
        secretsText: '{}',
      };
    }

    async function patchSource(enabled?: boolean): Promise<void> {
      await run(async () => {
        await request(`/api/admin/sources/${state.sourceForm.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            name: state.sourceForm.name,
            type: state.sourceForm.type,
            enabled: enabled ?? state.sourceForm.enabled,
            config: parseJsonObject(state.sourceForm.configText),
          }),
        });
        await loadSources();
      }, t.value.messages.sourceUpdated);
    }

    async function rotateSourceSecret(): Promise<void> {
      await run(async () => {
        await request(`/api/admin/sources/${state.sourceForm.id}/rotate-secret`, {
          method: 'POST',
          body: JSON.stringify({
            secrets: parseJsonObject(state.sourceForm.secretsText),
          }),
        });
        await loadSources();
      }, t.value.messages.sourceSecretRotated);
    }

    async function loadChannels(): Promise<void> {
      const data = await request<{ channels: ChannelRow[] }>('/api/admin/channels');
      state.channels = data.channels;
    }

    async function saveChannel(): Promise<void> {
      await run(async () => {
        const body = channelRequestBody(state.channelForm);

        const data = await request<{ channel: ChannelRow }>('/api/admin/channels', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        editChannel(data.channel);
        await loadChannels();
      }, t.value.messages.channelSaved);
    }

    function editChannel(channel: ChannelRow): void {
      state.channelForm = {
        id: channel.id,
        name: channel.name,
        type: channelTypeOrDefault(channel.type),
        enabled: channel.enabled,
        configText: pretty(channel.config),
        secretsText: '{}',
        testText: state.channelForm.testText,
        fields: channelFieldsFromConfig(channel.type, channel.config),
      };
    }

    async function patchChannel(enabled?: boolean): Promise<void> {
      await run(async () => {
        const body = channelRequestBody(state.channelForm, enabled ?? state.channelForm.enabled);

        await request(`/api/admin/channels/${state.channelForm.id}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
        await loadChannels();
      }, t.value.messages.channelUpdated);
    }

    async function setChannelEnabled(
      enabled: boolean,
      channelId = state.channelForm.id,
    ): Promise<void> {
      await run(async () => {
        await request(`/api/admin/channels/${channelId}`, {
          method: 'PATCH',
          body: JSON.stringify({ enabled }),
        });

        if (state.channelForm.id === channelId) {
          state.channelForm.enabled = enabled;
        }

        await loadChannels();
      }, t.value.messages.channelUpdated);
    }

    async function testChannel(channelId = state.channelForm.id): Promise<void> {
      await run(async () => {
        await request(`/api/admin/channels/${channelId}/test`, {
          method: 'POST',
          body: JSON.stringify({
            message: {
              text: state.channelForm.testText,
            },
          }),
        });
      }, t.value.messages.testSent);
    }

    async function loadRules(): Promise<void> {
      const data = await request<{ rules: RuleRow[] }>('/api/admin/rules');
      state.rules = data.rules;
    }

    async function saveRule(): Promise<void> {
      await run(async () => {
        await request('/api/admin/rules', {
          method: 'POST',
          body: JSON.stringify({
            id: optionalText(state.ruleForm.id),
            sourceId: optionalText(state.ruleForm.sourceId),
            name: state.ruleForm.name,
            enabled: state.ruleForm.enabled,
            priority: Number(state.ruleForm.priority),
            stopOnMatch: state.ruleForm.stopOnMatch,
            match: parseJsonObject(state.ruleForm.matchText),
            template: parseJsonObject(state.ruleForm.templateText),
            channelIds: splitList(state.ruleForm.channelIdsText),
          }),
        });
        await loadRules();
      }, t.value.messages.ruleSaved);
    }

    function editRule(rule: RuleRow): void {
      state.ruleForm = {
        id: rule.id,
        sourceId: rule.sourceId ?? '',
        name: rule.name,
        enabled: rule.enabled,
        priority: rule.priority,
        stopOnMatch: rule.stopOnMatch,
        matchText: pretty(rule.match),
        templateText: pretty(rule.template),
        channelIdsText: rule.channelIds.join(', '),
        samplePayloadText: state.ruleForm.samplePayloadText,
      };
    }

    async function patchRule(enabled?: boolean): Promise<void> {
      await run(async () => {
        await request(`/api/admin/rules/${state.ruleForm.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            sourceId: optionalText(state.ruleForm.sourceId),
            name: state.ruleForm.name,
            enabled: enabled ?? state.ruleForm.enabled,
            priority: Number(state.ruleForm.priority),
            stopOnMatch: state.ruleForm.stopOnMatch,
            match: parseJsonObject(state.ruleForm.matchText),
            template: parseJsonObject(state.ruleForm.templateText),
            channelIds: splitList(state.ruleForm.channelIdsText),
          }),
        });
        await loadRules();
      }, t.value.messages.ruleUpdated);
    }

    async function previewRule(): Promise<void> {
      await run(async () => {
        const data = await request<JsonRecord>(`/api/admin/rules/${state.ruleForm.id}/preview`, {
          method: 'POST',
          body: JSON.stringify({
            payload: parseJsonObject(state.ruleForm.samplePayloadText),
          }),
        });
        state.previewResult = pretty(data);
      });
    }

    async function loadOutbox(): Promise<void> {
      const query = new URLSearchParams();

      if (state.outboxStatus) {
        query.set('status', state.outboxStatus);
      }

      if (state.outboxSourceId) {
        query.set('sourceId', state.outboxSourceId);
      }

      if (state.outboxChannelId) {
        query.set('channelId', state.outboxChannelId);
      }

      const createdFrom = dateInputToUnixMs(state.outboxCreatedFrom);
      const createdTo = dateInputToUnixMs(state.outboxCreatedTo);

      if (createdFrom !== undefined) {
        query.set('createdFrom', String(createdFrom));
      }

      if (createdTo !== undefined) {
        query.set('createdTo', String(createdTo));
      }

      const suffix = query.size > 0 ? `?${query.toString()}` : '';
      const data = await request<{ outbox: OutboxRow[] }>(`/api/admin/outbox${suffix}`);
      state.outbox = data.outbox;
    }

    async function selectOutbox(id: string): Promise<void> {
      await run(async () => {
        const data = await request<{ item: OutboxRow }>(`/api/admin/outbox/${id}`);
        state.selectedOutbox = data.item;
      });
    }

    async function replayOutbox(id: string): Promise<void> {
      await run(async () => {
        await request(`/api/admin/outbox/${id}/replay`, { method: 'POST' });
        await loadOutbox();
      }, t.value.messages.replayQueued);
    }

    async function cancelOutbox(id: string): Promise<void> {
      await run(async () => {
        await request(`/api/admin/outbox/${id}/cancel`, { method: 'POST' });
        await loadOutbox();
      }, t.value.messages.outboxCancelled);
    }

    async function loadSentLog(): Promise<void> {
      const data = await request<{ sentLog: SentLogRow[] }>('/api/admin/sent-log');
      state.sentLog = data.sentLog;
    }

    async function loadSettings(): Promise<void> {
      const data = await request<SettingsResponse>('/api/admin/settings');
      state.settingsForm.retentionText = pretty(data.retention);
      state.settingsForm.retryText = pretty(data.retry);
    }

    async function saveSettings(): Promise<void> {
      await run(async () => {
        await request('/api/admin/settings', {
          method: 'PATCH',
          body: JSON.stringify({
            retention: parseJsonObject(state.settingsForm.retentionText),
            retry: parseJsonObject(state.settingsForm.retryText),
          }),
        });
        await loadSettings();
      }, t.value.messages.settingsSaved);
    }

    async function changePassword(): Promise<void> {
      await run(async () => {
        await request('/api/admin/password', {
          method: 'POST',
          body: JSON.stringify({
            currentPassword: state.settingsForm.currentPassword,
            newPassword: state.settingsForm.newPassword,
          }),
        });
        state.settingsForm.currentPassword = '';
        state.settingsForm.newPassword = '';
      }, t.value.messages.passwordChanged);
    }

    function webhookUrl(path: string): string {
      return `${window.location.origin}${path}`;
    }

    function toggleLanguage(): void {
      locale.value = locale.value === 'en' ? 'zh' : 'en';

      try {
        localStorage.setItem(languageStorageKey, locale.value);
      } catch {
        // Keep the current-session language switch working even when storage is unavailable.
      }
    }

    function tabLabel(tab: Tab): string {
      return t.value.tabs[tab];
    }

    function statusLabel(status: string): string {
      return isStatusKey(status) ? t.value.status[status] : status;
    }

    function booleanLabel(value: boolean): string {
      return value ? t.value.common.true : t.value.common.false;
    }

    function secretLabel(value: boolean): string {
      return value ? t.value.common.set : t.value.common.empty;
    }

    function sourceTypeLabel(type: SourceType): string {
      return t.value.sourceTypes[type];
    }

    function applySourceTypePreset(): void {
      const type = sourceTypeOrDefault(state.sourceForm.type);
      const preset = sourceTypePresets[type];
      state.sourceForm.type = type;
      state.sourceForm.configText = pretty(preset.config);
      state.sourceForm.secretsText = '{}';

      if (type !== 'generic' && state.sourceForm.id.trim().length === 0) {
        state.sourceForm.id = type;
      }

      if (type !== 'generic' && state.sourceForm.name.trim().length === 0) {
        state.sourceForm.name = sourceTypeLabel(type);
      }
    }

    function selectedRuleSourceType(): SourceType | null {
      const source = state.sources.find((item) => item.id === state.ruleForm.sourceId);

      return source && isSourceType(source.type) ? source.type : null;
    }

    function applyRuleSourcePreset(): void {
      const type = selectedRuleSourceType();

      if (!type) {
        return;
      }

      const preset = sourceTypePresets[type];
      state.ruleForm.matchText = pretty(preset.match);
      state.ruleForm.templateText = pretty(preset.template);
      state.ruleForm.samplePayloadText = pretty(preset.samplePayload);
    }

    function sourceSetupHelp(): string {
      return state.sourceForm.type === 'komari'
        ? t.value.sourceHelp.komariSetup
        : t.value.sourceHelp.wallosSetup;
    }

    function sourceUpstreamSetup(): string {
      const endpoint = sourceWebhookEndpoint();

      if (state.sourceForm.type === 'komari') {
        return [
          `url: ${endpoint}`,
          'method: POST',
          'content_type: application/json',
          'headers: {}',
          'body:',
          pretty(komariWebhookBody),
          'username:',
          'password:',
        ].join('\n');
      }

      if (state.sourceForm.type === 'wallos') {
        return [
          `webhook_url: ${endpoint}`,
          'request_method: POST',
          'custom_headers:',
          'payment_payload:',
          pretty(wallosPaymentWebhookBody),
          'cancelation_payload:',
          pretty(wallosCancellationWebhookBody),
          'ignore_ssl: false',
        ].join('\n');
      }

      return '';
    }

    function sourceWebhookEndpoint(): string {
      const existing = state.sources.find((source) => source.id === state.sourceForm.id);

      if (existing) {
        return webhookUrl(existing.webhookPath);
      }

      const sourceId = state.sourceForm.id.trim();

      return sourceId.length > 0
        ? `${window.location.origin}/hooks/${encodeURIComponent(sourceId)}`
        : `${window.location.origin}/hooks/<source-id>`;
    }

    function sourceDedupeWarning(): boolean {
      if (state.sourceForm.type !== 'generic') {
        return false;
      }

      try {
        const config = parseJsonObject(state.sourceForm.configText);

        return (
          typeof config.inboundDedupePath !== 'string' || config.inboundDedupePath.length === 0
        );
      } catch {
        return false;
      }
    }

    function nullableText(value: string | number | null | undefined): string {
      return value === null || value === undefined || value === ''
        ? t.value.common.empty
        : String(value);
    }

    function channelTypeLabel(type: ChannelType): string {
      return t.value.channelTypes[type];
    }

    function channelExists(channelId = state.channelForm.id): boolean {
      return channelId.length > 0 && state.channels.some((channel) => channel.id === channelId);
    }

    function channelIsEnabled(channelId = state.channelForm.id): boolean {
      return (
        state.channels.find((channel) => channel.id === channelId)?.enabled ??
        state.channelForm.enabled
      );
    }

    function isRuleChannelSelected(channelId: string): boolean {
      return splitList(state.ruleForm.channelIdsText).includes(channelId);
    }

    function toggleRuleChannel(channelId: string, event: Event): void {
      const target = event.target;

      if (!(target instanceof HTMLInputElement)) {
        return;
      }

      const selected = new Set(splitList(state.ruleForm.channelIdsText));

      if (target.checked) {
        selected.add(channelId);
      } else {
        selected.delete(channelId);
      }

      state.ruleForm.channelIdsText = [...selected].join(', ');
    }

    function applyChannelTypePreset(): void {
      const preset = channelTypePresets[state.channelForm.type];

      if (!preset) {
        return;
      }

      state.channelForm.configText = pretty(preset.config);
      state.channelForm.secretsText = pretty(preset.secrets);
      state.channelForm.fields = defaultChannelFields(state.channelForm.type);
    }

    function applyOutlookSmtpPreset(): void {
      state.channelForm.type = 'smtp';
      applyChannelTypePreset();
      state.channelForm.fields.smtpHost = 'smtp.office365.com';
      state.channelForm.fields.smtpPort = 587;
      state.channelForm.fields.smtpUseSsl = true;
      state.channelForm.fields.smtpUseLoginAuth = true;
    }

    onMounted(() => {
      void refreshStatus();
    });

    return {
      tabs,
      sourceTypes,
      channelTypes,
      locale,
      t,
      state,
      toggleLanguage,
      tabLabel,
      statusLabel,
      booleanLabel,
      secretLabel,
      sourceTypeLabel,
      applySourceTypePreset,
      selectedRuleSourceType,
      applyRuleSourcePreset,
      sourceSetupHelp,
      sourceUpstreamSetup,
      sourceDedupeWarning,
      nullableText,
      channelTypeLabel,
      channelExists,
      channelIsEnabled,
      isRuleChannelSelected,
      toggleRuleChannel,
      applyChannelTypePreset,
      applyOutlookSmtpPreset,
      setTab,
      refreshCurrentTab,
      submitAuth,
      logout,
      saveSource,
      editSource,
      patchSource,
      rotateSourceSecret,
      saveChannel,
      editChannel,
      patchChannel,
      setChannelEnabled,
      testChannel,
      saveRule,
      editRule,
      patchRule,
      previewRule,
      loadOutbox,
      selectOutbox,
      replayOutbox,
      cancelOutbox,
      loadSentLog,
      loadSettings,
      saveSettings,
      changePassword,
      webhookUrl,
      pretty,
      formatTime,
    };
  },
  template: `
    <main v-if="!state.authenticated" class="auth">
      <button class="language-toggle auth-language-toggle" type="button" :aria-label="t.language.ariaLabel" @click="toggleLanguage">
        {{ t.language.toggle }}
      </button>
      <section class="auth-panel">
        <div class="auth-brand">
          <span class="auth-logo"></span>
          <h1>{{ t.app.title }}</h1>
          <p>{{ t.app.subtitle }}</p>
        </div>
        <form class="panel-body" @submit.prevent="submitAuth">
          <label>
            {{ t.auth.password }}
            <input v-model="state.password" type="password" autocomplete="current-password" />
          </label>
          <button class="primary" type="submit" :disabled="state.loading">
            {{ state.initialized ? t.auth.login : t.auth.initialize }}
          </button>
          <div v-if="state.error" class="notice error">{{ state.error }}</div>
        </form>
      </section>
    </main>

    <main v-else class="app-shell">
      <header class="topbar">
        <div class="brand">
          <h1>{{ t.app.title }}</h1>
          <span>{{ t.app.subtitle }}</span>
        </div>
        <div class="topbar-actions">
          <button class="language-toggle" type="button" :aria-label="t.language.ariaLabel" @click="toggleLanguage">
            {{ t.language.toggle }}
          </button>
          <button @click="logout">{{ t.buttons.logout }}</button>
        </div>
      </header>

      <nav class="nav">
        <button
          v-for="tab in tabs"
          :key="tab"
          :class="{ active: state.activeTab === tab }"
          @click="setTab(tab)"
        >
          {{ tabLabel(tab) }}
        </button>
      </nav>

      <section class="page">
        <div v-if="state.notice" class="notice">{{ state.notice }}</div>
        <div v-if="state.error" class="notice error">{{ state.error }}</div>

        <template v-if="state.activeTab === 'dashboard'">
          <section class="metrics">
            <div class="metric"><span>{{ t.metrics.receivedLast24h }}</span><strong>{{ state.dashboard.receivedLast24h }}</strong></div>
            <div class="metric metric--pending"><span>{{ t.metrics.pending }}</span><strong>{{ state.dashboard.outboxByStatus.pending }}</strong></div>
            <div class="metric metric--sending"><span>{{ t.metrics.sending }}</span><strong>{{ state.dashboard.outboxByStatus.sending }}</strong></div>
            <div class="metric metric--sent"><span>{{ t.metrics.sent }}</span><strong>{{ state.dashboard.outboxByStatus.sent }}</strong></div>
            <div class="metric metric--dead"><span>{{ t.metrics.dead }}</span><strong>{{ state.dashboard.outboxByStatus.dead }}</strong></div>
            <div class="metric metric--cancelled"><span>{{ t.metrics.cancelled }}</span><strong>{{ state.dashboard.outboxByStatus.cancelled }}</strong></div>
          </section>
          <section class="panel">
            <div class="panel-header">
              <h2>{{ t.sections.recentErrors }}</h2>
              <button type="button" :disabled="state.loading" @click="refreshCurrentTab">{{ t.buttons.refresh }}</button>
            </div>
            <div class="table-wrap">
              <table>
                <thead><tr><th>{{ t.labels.id }}</th><th>{{ t.tables.status }}</th><th>{{ t.tables.error }}</th><th>{{ t.tables.updated }}</th></tr></thead>
                <tbody>
                  <tr v-for="item in state.dashboard.recentErrors" :key="item.id">
                    <td class="mono">{{ item.id }}</td>
                    <td><span class="status" :class="item.status">{{ statusLabel(item.status) }}</span></td>
                    <td>{{ item.lastError }}</td>
                    <td>{{ formatTime(item.nextAt) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </template>

        <template v-if="state.activeTab === 'sources'">
          <section class="split">
            <form class="panel" @submit.prevent="saveSource">
              <div class="panel-header"><h2>{{ t.sections.source }}</h2></div>
              <div class="panel-body form-grid">
                <label><span>{{ t.labels.id }}</span><input v-model="state.sourceForm.id" /></label>
                <label><span>{{ t.labels.name }}</span><input v-model="state.sourceForm.name" /></label>
                <label>
                  <span>{{ t.labels.type }}</span>
                  <select v-model="state.sourceForm.type" @change="applySourceTypePreset()">
                    <option v-for="type in sourceTypes" :key="type" :value="type">
                      {{ sourceTypeLabel(type) }}
                    </option>
                  </select>
                </label>
                <label><span>{{ t.labels.enabled }}</span><select v-model="state.sourceForm.enabled"><option :value="true">{{ t.common.true }}</option><option :value="false">{{ t.common.false }}</option></select></label>
                <div class="wide inline-actions">
                  <span class="muted">{{ t.sourceHelp.preset }}</span>
                  <button type="button" @click="applySourceTypePreset">{{ t.buttons.applyPreset }}</button>
                </div>
                <label class="wide"><span>{{ t.labels.configJson }}</span><textarea v-model="state.sourceForm.configText"></textarea></label>
                <div v-if="sourceDedupeWarning()" class="notice warning wide">{{ t.messages.genericDedupeWarning }}</div>
                <label class="wide"><span>{{ t.labels.secretJson }}</span><textarea v-model="state.sourceForm.secretsText"></textarea></label>
                <div class="actions wide">
                  <button class="primary" type="submit">{{ t.buttons.create }}</button>
                  <button type="button" @click="patchSource()">{{ t.buttons.update }}</button>
                  <button type="button" @click="rotateSourceSecret()">{{ t.buttons.rotateSecret }}</button>
                  <button type="button" @click="patchSource(false)">{{ t.buttons.disable }}</button>
                </div>
              </div>
            </form>
            <section class="panel">
              <div class="panel-header">
                <h2>{{ t.sections.sources }}</h2>
                <button type="button" :disabled="state.loading" @click="refreshCurrentTab">{{ t.buttons.refresh }}</button>
              </div>
              <div class="table-wrap">
                <table>
                  <thead><tr><th>{{ t.labels.name }}</th><th>{{ t.labels.type }}</th><th>{{ t.tables.webhook }}</th><th>{{ t.tables.secret }}</th><th>{{ t.tables.lastEvent }}</th><th></th></tr></thead>
                  <tbody>
                    <tr v-for="source in state.sources" :key="source.id">
                      <td>{{ source.name }}<br /><span class="muted mono">{{ source.id }}</span></td>
                      <td>{{ source.type }}</td>
                      <td class="mono">{{ webhookUrl(source.webhookPath) }}</td>
                      <td>{{ secretLabel(source.hasSecret) }}</td>
                      <td>{{ formatTime(source.lastEventAt) }}<br /><span class="muted mono">{{ nullableText(source.lastEventType) }} · {{ nullableText(source.lastEventSeenCount) }}</span></td>
                      <td><button @click="editSource(source)">{{ t.buttons.edit }}</button></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>
          </section>
          <section v-if="state.sourceForm.type === 'komari' || state.sourceForm.type === 'wallos'" class="panel">
            <div class="panel-header"><h2>{{ t.sections.upstreamTemplate }}</h2></div>
            <div class="panel-body">
              <div class="form-note">{{ sourceSetupHelp() }}</div>
              <pre>{{ sourceUpstreamSetup() }}</pre>
            </div>
          </section>
        </template>

        <template v-if="state.activeTab === 'channels'">
          <section class="split">
            <form class="panel" @submit.prevent="saveChannel">
              <div class="panel-header"><h2>{{ t.sections.channel }}</h2></div>
              <div class="panel-body form-grid">
                <label><span>{{ t.labels.id }}</span><input v-model="state.channelForm.id" /></label>
                <label><span>{{ t.labels.name }}</span><input v-model="state.channelForm.name" /></label>
                <label>
                  <span>{{ t.labels.type }}</span>
                  <select v-model="state.channelForm.type" @change="applyChannelTypePreset()">
                    <option v-for="type in channelTypes" :key="type" :value="type">{{ channelTypeLabel(type) }}</option>
                  </select>
                </label>
                <label><span>{{ t.labels.enabled }}</span><select v-model="state.channelForm.enabled"><option :value="true">{{ t.common.true }}</option><option :value="false">{{ t.common.false }}</option></select></label>
                <div class="wide form-note">{{ t.channelHelp.webUiOnly }}</div>

                <template v-if="state.channelForm.type === 'telegram'">
                  <label><span>{{ t.channelFields.telegramChatId }}</span><input v-model="state.channelForm.fields.telegramChatId" /></label>
                  <label><span>{{ t.channelFields.telegramBotToken }}</span><input v-model="state.channelForm.fields.telegramBotToken" type="password" autocomplete="off" /></label>
                  <label><span>{{ t.channelFields.telegramParseMode }}</span><input v-model="state.channelForm.fields.telegramParseMode" placeholder="HTML / MarkdownV2" /></label>
                  <label>
                    <span>{{ t.channelFields.disableWebPagePreview }}</span>
                    <select v-model="state.channelForm.fields.telegramDisableWebPagePreview">
                      <option value="">{{ t.common.default }}</option>
                      <option value="true">{{ t.common.true }}</option>
                      <option value="false">{{ t.common.false }}</option>
                    </select>
                  </label>
                </template>

                <template v-if="state.channelForm.type === 'resend'">
                  <label><span>{{ t.channelFields.from }}</span><input v-model="state.channelForm.fields.resendFrom" /></label>
                  <label><span>{{ t.channelFields.to }}</span><textarea class="textarea-compact" v-model="state.channelForm.fields.resendTo"></textarea></label>
                  <label><span>{{ t.channelFields.subject }}</span><input v-model="state.channelForm.fields.resendSubject" /></label>
                  <label><span>{{ t.channelFields.resendApiKey }}</span><input v-model="state.channelForm.fields.resendApiKey" type="password" autocomplete="off" /></label>
                  <label><span>{{ t.channelFields.replyTo }}</span><input v-model="state.channelForm.fields.resendReplyTo" /></label>
                  <label><span>{{ t.channelFields.endpoint }}</span><input v-model="state.channelForm.fields.resendEndpoint" /></label>
                </template>

                <template v-if="state.channelForm.type === 'smtp'">
                  <div class="wide inline-actions">
                    <span class="muted">{{ t.channelHelp.smtpOutlook }}</span>
                    <button type="button" @click="applyOutlookSmtpPreset">{{ t.buttons.outlookPreset }}</button>
                  </div>
                  <label><span>{{ t.channelFields.smtpHost }}</span><input v-model="state.channelForm.fields.smtpHost" placeholder="smtp.office365.com" /></label>
                  <label><span>{{ t.channelFields.smtpPort }}</span><input v-model.number="state.channelForm.fields.smtpPort" type="number" min="1" max="65535" /></label>
                  <label class="check-row"><input v-model="state.channelForm.fields.smtpUseSsl" type="checkbox" /><span>{{ t.channelFields.useSsl }}</span></label>
                  <label class="check-row"><input v-model="state.channelForm.fields.smtpUseLoginAuth" type="checkbox" /><span>{{ t.channelFields.useLoginAuth }}</span></label>
                  <label><span>{{ t.channelFields.from }}</span><input v-model="state.channelForm.fields.smtpFrom" /></label>
                  <label><span>{{ t.channelFields.to }}</span><textarea class="textarea-compact" v-model="state.channelForm.fields.smtpTo"></textarea></label>
                  <label><span>{{ t.channelFields.subject }}</span><input v-model="state.channelForm.fields.smtpSubject" /></label>
                  <label><span>{{ t.channelFields.smtpUser }}</span><input v-model="state.channelForm.fields.smtpUser" autocomplete="username" /></label>
                  <label><span>{{ t.channelFields.smtpPass }}</span><input v-model="state.channelForm.fields.smtpPass" type="password" autocomplete="new-password" /></label>
                </template>

                <template v-if="state.channelForm.type === 'webhook'">
                  <label><span>{{ t.channelFields.webhookUrl }}</span><input v-model="state.channelForm.fields.webhookUrl" /></label>
                  <label><span>{{ t.channelFields.webhookMethod }}</span><input v-model="state.channelForm.fields.webhookMethod" /></label>
                  <label><span>{{ t.channelFields.idempotencyHeader }}</span><input v-model="state.channelForm.fields.webhookIdempotencyHeader" /></label>
                  <label class="wide"><span>{{ t.channelFields.headersJson }}</span><textarea class="textarea-compact" v-model="state.channelForm.fields.webhookHeadersText"></textarea></label>
                  <label class="wide"><span>{{ t.channelFields.secretHeadersJson }}</span><textarea class="textarea-compact" v-model="state.channelForm.fields.webhookSecretHeadersText"></textarea></label>
                </template>

                <div class="wide secret-hint">{{ t.channelHelp.writeOnlySecrets }}</div>
                <details class="wide advanced-json">
                  <summary>{{ t.channelHelp.advancedJson }}</summary>
                  <label><span>{{ t.labels.configJson }}</span><textarea v-model="state.channelForm.configText"></textarea></label>
                  <label><span>{{ t.labels.secretJson }}</span><textarea v-model="state.channelForm.secretsText"></textarea></label>
                </details>
                <label class="wide"><span>{{ t.labels.testText }}</span><input v-model="state.channelForm.testText" /></label>
                <div class="actions wide">
                  <button class="primary" type="submit">{{ t.buttons.create }}</button>
                  <button type="button" :disabled="!channelExists()" @click="patchChannel()">{{ t.buttons.update }}</button>
                  <button type="button" :disabled="!channelExists()" :title="channelExists() ? '' : t.channelHelp.saveBeforeTest" @click="testChannel()">{{ t.buttons.test }}</button>
                  <button type="button" :disabled="!channelExists()" @click="setChannelEnabled(!channelIsEnabled())">
                    {{ channelIsEnabled() ? t.buttons.disable : t.buttons.enable }}
                  </button>
                </div>
              </div>
            </form>
            <section class="panel">
              <div class="panel-header">
                <h2>{{ t.sections.channels }}</h2>
                <button type="button" :disabled="state.loading" @click="refreshCurrentTab">{{ t.buttons.refresh }}</button>
              </div>
              <div class="table-wrap">
                <table>
                  <thead><tr><th>{{ t.labels.name }}</th><th>{{ t.labels.type }}</th><th>{{ t.labels.enabled }}</th><th>{{ t.tables.secret }}</th><th></th></tr></thead>
                  <tbody>
                    <tr v-for="channel in state.channels" :key="channel.id">
                      <td>{{ channel.name }}<br /><span class="muted mono">{{ channel.id }}</span></td>
                      <td>{{ channel.type }}</td>
                      <td>{{ booleanLabel(channel.enabled) }}</td>
                      <td>{{ secretLabel(channel.hasSecret) }}</td>
                      <td class="actions"><button @click="editChannel(channel)">{{ t.buttons.edit }}</button><button @click="testChannel(channel.id)">{{ t.buttons.test }}</button><button @click="setChannelEnabled(!channel.enabled, channel.id)">{{ channel.enabled ? t.buttons.disable : t.buttons.enable }}</button></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>
          </section>
        </template>

        <template v-if="state.activeTab === 'rules'">
          <section class="split">
            <form class="panel" @submit.prevent="saveRule">
              <div class="panel-header"><h2>{{ t.sections.rule }}</h2></div>
              <div class="panel-body form-grid">
                <label><span>{{ t.labels.id }}</span><input v-model="state.ruleForm.id" /></label>
                <label><span>{{ t.labels.name }}</span><input v-model="state.ruleForm.name" /></label>
                <label>
                  <span>{{ t.labels.sourceId }}</span>
                  <select v-model="state.ruleForm.sourceId">
                    <option value="">{{ t.common.allSources }}</option>
                    <option v-for="source in state.sources" :key="source.id" :value="source.id">
                      {{ source.name }} · {{ source.id }}
                    </option>
                  </select>
                </label>
                <label><span>{{ t.labels.priority }}</span><input v-model.number="state.ruleForm.priority" type="number" /></label>
                <label><span>{{ t.labels.enabled }}</span><select v-model="state.ruleForm.enabled"><option :value="true">{{ t.common.true }}</option><option :value="false">{{ t.common.false }}</option></select></label>
                <label><span>{{ t.labels.stopOnMatch }}</span><select v-model="state.ruleForm.stopOnMatch"><option :value="true">{{ t.common.true }}</option><option :value="false">{{ t.common.false }}</option></select></label>
                <div v-if="selectedRuleSourceType()" class="wide inline-actions">
                  <span class="muted">{{ t.sourceHelp.rulePreset }}</span>
                  <button type="button" @click="applyRuleSourcePreset">{{ t.buttons.applyPreset }}</button>
                </div>
                <label class="wide"><span>{{ t.labels.matchJson }}</span><textarea v-model="state.ruleForm.matchText"></textarea></label>
                <label class="wide"><span>{{ t.labels.templateJson }}</span><textarea v-model="state.ruleForm.templateText"></textarea></label>
                <div class="field-group wide">
                  <span class="field-label">{{ t.labels.channelIds }}</span>
                  <div v-if="state.channels.length > 0" class="choice-list">
                    <label v-for="channel in state.channels" :key="channel.id" class="choice-row">
                      <input
                        type="checkbox"
                        :checked="isRuleChannelSelected(channel.id)"
                        @change="toggleRuleChannel(channel.id, $event)"
                      />
                      <span class="choice-copy">
                        <strong>{{ channel.name }}</strong>
                        <small>{{ channel.id }} · {{ channel.type }}</small>
                      </span>
                    </label>
                  </div>
                  <div v-else class="form-note">{{ t.messages.createChannelFirst }}</div>
                </div>
                <label class="wide"><span>{{ t.labels.samplePayload }}</span><textarea v-model="state.ruleForm.samplePayloadText"></textarea></label>
                <div class="actions wide">
                  <button class="primary" type="submit">{{ t.buttons.create }}</button>
                  <button type="button" @click="patchRule()">{{ t.buttons.update }}</button>
                  <button type="button" @click="previewRule()">{{ t.buttons.preview }}</button>
                  <button type="button" @click="patchRule(false)">{{ t.buttons.disable }}</button>
                </div>
                <pre v-if="state.previewResult" class="wide">{{ state.previewResult }}</pre>
              </div>
            </form>
            <section class="panel">
              <div class="panel-header">
                <h2>{{ t.sections.rules }}</h2>
                <button type="button" :disabled="state.loading" @click="refreshCurrentTab">{{ t.buttons.refresh }}</button>
              </div>
              <div class="table-wrap">
                <table>
                  <thead><tr><th>{{ t.labels.name }}</th><th>{{ t.tables.source }}</th><th>{{ t.labels.enabled }}</th><th>{{ t.labels.priority }}</th><th>{{ t.labels.stopOnMatch }}</th><th>{{ t.tables.channels }}</th><th></th></tr></thead>
                  <tbody>
                    <tr v-for="rule in state.rules" :key="rule.id">
                      <td>{{ rule.name }}<br /><span class="muted mono">{{ rule.id }}</span></td>
                      <td class="mono">{{ rule.sourceId }}</td>
                      <td>{{ booleanLabel(rule.enabled) }}</td>
                      <td>{{ rule.priority }}</td>
                      <td>{{ booleanLabel(rule.stopOnMatch) }}</td>
                      <td class="mono">{{ rule.channelIds.join(', ') }}</td>
                      <td class="actions"><button @click="editRule(rule)">{{ t.buttons.edit }}</button><button @click="editRule(rule); patchRule(false)">{{ t.buttons.disable }}</button></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>
          </section>
        </template>

        <template v-if="state.activeTab === 'outbox'">
          <section class="panel">
            <div class="panel-header">
              <h2>{{ t.sections.outbox }}</h2>
              <div class="actions filters">
                <select v-model="state.outboxStatus" @change="loadOutbox">
                  <option value="">{{ t.filters.all }}</option>
                  <option value="pending">{{ t.status.pending }}</option>
                  <option value="sending">{{ t.status.sending }}</option>
                  <option value="sent">{{ t.status.sent }}</option>
                  <option value="dead">{{ t.status.dead }}</option>
                  <option value="cancelled">{{ t.status.cancelled }}</option>
                </select>
                <input v-model="state.outboxSourceId" :placeholder="t.labels.sourceId" @change="loadOutbox" />
                <input v-model="state.outboxChannelId" :placeholder="t.tables.channel" @change="loadOutbox" />
                <input v-model="state.outboxCreatedFrom" type="datetime-local" :aria-label="t.labels.createdFrom" @change="loadOutbox" />
                <input v-model="state.outboxCreatedTo" type="datetime-local" :aria-label="t.labels.createdTo" @change="loadOutbox" />
                <button @click="loadOutbox">{{ t.buttons.refresh }}</button>
              </div>
            </div>
            <div class="table-wrap">
              <table>
                <thead><tr><th>{{ t.labels.id }}</th><th>{{ t.tables.status }}</th><th>{{ t.tables.source }}</th><th>{{ t.tables.channel }}</th><th>{{ t.tables.attempts }}</th><th>{{ t.labels.nextAt }}</th><th>{{ t.tables.error }}</th><th></th></tr></thead>
                <tbody>
                  <tr v-for="item in state.outbox" :key="item.id">
                    <td class="mono">{{ item.id }}</td>
                    <td><span class="status" :class="item.status">{{ statusLabel(item.status) }}</span></td>
                    <td class="mono">{{ item.sourceId }}</td>
                    <td class="mono">{{ item.channelId }}</td>
                    <td>{{ item.attempts }} / {{ item.maxAttempts }}</td>
                    <td>{{ formatTime(item.nextAt) }}</td>
                    <td>{{ item.lastError }}</td>
                    <td class="actions">
                      <button @click="selectOutbox(item.id)">{{ t.buttons.view }}</button>
                      <button v-if="item.status === 'dead' || item.status === 'cancelled'" @click="replayOutbox(item.id)">{{ t.buttons.replay }}</button>
                      <button v-if="item.status === 'pending' || item.status === 'sending'" class="danger" @click="cancelOutbox(item.id)">{{ t.buttons.cancel }}</button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
          <pre v-if="state.selectedOutbox">{{ pretty(state.selectedOutbox) }}</pre>
        </template>

        <template v-if="state.activeTab === 'sent-log'">
          <section class="panel">
            <div class="panel-header"><h2>{{ t.sections.sentLog }}</h2><button @click="loadSentLog">{{ t.buttons.refresh }}</button></div>
            <div class="table-wrap">
              <table>
                <thead><tr><th>{{ t.labels.id }}</th><th>{{ t.tables.outbox }}</th><th>{{ t.tables.channel }}</th><th>{{ t.tables.provider }}</th><th>{{ t.tables.dedupeKey }}</th><th>{{ t.tables.sent }}</th></tr></thead>
                <tbody>
                  <tr v-for="entry in state.sentLog" :key="entry.id">
                    <td class="mono">{{ entry.id }}</td>
                    <td class="mono">{{ entry.outboxId }}</td>
                    <td class="mono">{{ entry.channelId }}</td>
                    <td>{{ entry.providerMessageId }}</td>
                    <td class="mono">{{ entry.outboundDedupeKey }}</td>
                    <td>{{ formatTime(entry.sentAt) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </template>

        <template v-if="state.activeTab === 'settings'">
          <section class="split">
            <form class="panel" @submit.prevent="saveSettings">
              <div class="panel-header"><h2>{{ t.sections.settings }}</h2></div>
              <div class="panel-body form-grid">
                <label class="wide"><span>{{ t.labels.retentionJson }}</span><textarea v-model="state.settingsForm.retentionText"></textarea></label>
                <label class="wide"><span>{{ t.labels.retryJson }}</span><textarea v-model="state.settingsForm.retryText"></textarea></label>
                <div class="actions wide">
                  <button class="primary" type="submit">{{ t.buttons.saveSettings }}</button>
                  <button type="button" @click="loadSettings">{{ t.buttons.refresh }}</button>
                </div>
              </div>
            </form>
            <form class="panel" @submit.prevent="changePassword">
              <div class="panel-header"><h2>{{ t.sections.password }}</h2></div>
              <div class="panel-body form-grid">
                <label class="wide"><span>{{ t.labels.currentPassword }}</span><input v-model="state.settingsForm.currentPassword" type="password" autocomplete="current-password" /></label>
                <label class="wide"><span>{{ t.labels.newPassword }}</span><input v-model="state.settingsForm.newPassword" type="password" autocomplete="new-password" /></label>
                <div class="actions wide">
                  <button class="primary" type="submit">{{ t.buttons.changePassword }}</button>
                </div>
              </div>
            </form>
          </section>
        </template>
      </section>
    </main>
  `,
});

app.mount('#app');

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function parseJsonObject(raw: string): JsonRecord {
  const value = JSON.parse(raw) as unknown;

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('JSON must be an object');
  }

  return value as JsonRecord;
}

function parseOptionalJsonObject(raw: string): JsonRecord {
  return raw.trim().length === 0 ? {} : parseJsonObject(raw);
}

function sourceTypeOrDefault(value: string): SourceType {
  return isSourceType(value) ? value : 'generic';
}

function isSourceType(value: string): value is SourceType {
  return (sourceTypes as readonly string[]).includes(value);
}

function createChannelForm(type: ChannelType = 'telegram'): ChannelFormState {
  const preset = channelTypePresets[type];

  return {
    id: '',
    name: '',
    type,
    enabled: true,
    configText: pretty(preset.config),
    secretsText: pretty(preset.secrets),
    testText: 'Test message from Kaname Relay',
    fields: defaultChannelFields(type),
  };
}

function defaultChannelFields(type: ChannelType): ChannelFields {
  const fields: ChannelFields = {
    telegramChatId: '',
    telegramParseMode: '',
    telegramDisableWebPagePreview: '',
    telegramBotToken: '',
    resendFrom: '',
    resendTo: '',
    resendSubject: 'Kaname Relay notification',
    resendReplyTo: '',
    resendEndpoint: '',
    resendApiKey: '',
    smtpHost: '',
    smtpPort: 587,
    smtpUseSsl: true,
    smtpUseLoginAuth: false,
    smtpFrom: '',
    smtpTo: '',
    smtpSubject: 'Kaname Relay notification',
    smtpUser: '',
    smtpPass: '',
    webhookUrl: '',
    webhookMethod: 'POST',
    webhookHeadersText: '{}',
    webhookIdempotencyHeader: 'Idempotency-Key',
    webhookSecretHeadersText: '{}',
  };
  const preset = channelTypePresets[type];

  return channelFieldsFromConfig(type, preset.config, fields);
}

function channelTypeOrDefault(value: string): ChannelType {
  return isChannelType(value) ? value : 'webhook';
}

function isChannelType(value: string): value is ChannelType {
  return (channelTypes as readonly string[]).includes(value);
}

function channelFieldsFromConfig(
  type: string,
  config: JsonRecord,
  initial = baseChannelFields(),
): ChannelFields {
  const fields = { ...initial };

  if (type === 'telegram') {
    fields.telegramChatId = stringFromJson(config.chatId, fields.telegramChatId);
    fields.telegramParseMode = stringFromJson(config.parseMode, fields.telegramParseMode);
    fields.telegramDisableWebPagePreview = triStateFromJson(
      config.disableWebPagePreview,
      fields.telegramDisableWebPagePreview,
    );
  } else if (type === 'resend') {
    fields.resendFrom = stringFromJson(config.from, fields.resendFrom);
    fields.resendTo = addressTextFromJson(config.to, fields.resendTo);
    fields.resendSubject = stringFromJson(config.subject, fields.resendSubject);
    fields.resendReplyTo = stringFromJson(config.replyTo, fields.resendReplyTo);
    fields.resendEndpoint = stringFromJson(config.endpoint, fields.resendEndpoint);
  } else if (type === 'smtp') {
    fields.smtpHost = stringFromJson(config.host, fields.smtpHost);
    fields.smtpPort = numberFromJson(config.port, fields.smtpPort);
    fields.smtpUseSsl = booleanFromJson(
      config.use_ssl ?? config.useSsl ?? config.secure,
      fields.smtpUseSsl,
    );
    fields.smtpUseLoginAuth = booleanFromJson(
      config.use_login_auth ?? config.useLoginAuth,
      fields.smtpUseLoginAuth,
    );
    fields.smtpFrom = stringFromJson(config.from, fields.smtpFrom);
    fields.smtpTo = addressTextFromJson(config.to, fields.smtpTo);
    fields.smtpSubject = stringFromJson(config.subject, fields.smtpSubject);
  } else if (type === 'webhook') {
    fields.webhookUrl = stringFromJson(config.url, fields.webhookUrl);
    fields.webhookMethod = stringFromJson(config.method, fields.webhookMethod);
    fields.webhookHeadersText = pretty(jsonRecordFromJson(config.headers));
    fields.webhookIdempotencyHeader = stringFromJson(
      config.idempotencyHeader,
      fields.webhookIdempotencyHeader,
    );
  }

  return fields;
}

function baseChannelFields(): ChannelFields {
  return {
    telegramChatId: '',
    telegramParseMode: '',
    telegramDisableWebPagePreview: '',
    telegramBotToken: '',
    resendFrom: '',
    resendTo: '',
    resendSubject: '',
    resendReplyTo: '',
    resendEndpoint: '',
    resendApiKey: '',
    smtpHost: '',
    smtpPort: 587,
    smtpUseSsl: true,
    smtpUseLoginAuth: false,
    smtpFrom: '',
    smtpTo: '',
    smtpSubject: '',
    smtpUser: '',
    smtpPass: '',
    webhookUrl: '',
    webhookMethod: 'POST',
    webhookHeadersText: '{}',
    webhookIdempotencyHeader: '',
    webhookSecretHeadersText: '{}',
  };
}

function channelRequestBody(form: ChannelFormState, enabled = form.enabled): JsonRecord {
  const body: JsonRecord = {
    id: optionalText(form.id),
    name: form.name,
    type: form.type,
    enabled,
    config: channelConfigFromForm(form),
  };
  const secrets = channelSecretsFromForm(form);

  if (Object.keys(secrets).length > 0) {
    body.secrets = secrets;
  }

  return body;
}

function channelConfigFromForm(form: ChannelFormState): JsonRecord {
  const config = parseOptionalJsonObject(form.configText);
  const fields = form.fields;

  if (form.type === 'telegram') {
    setOptionalString(config, 'chatId', fields.telegramChatId);
    setOptionalString(config, 'parseMode', fields.telegramParseMode);
    setTriStateBoolean(config, 'disableWebPagePreview', fields.telegramDisableWebPagePreview);
  } else if (form.type === 'resend') {
    setOptionalString(config, 'from', fields.resendFrom);
    setAddressList(config, 'to', fields.resendTo);
    setOptionalString(config, 'subject', fields.resendSubject);
    setOptionalString(config, 'replyTo', fields.resendReplyTo);
    setOptionalString(config, 'endpoint', fields.resendEndpoint);
  } else if (form.type === 'smtp') {
    setOptionalString(config, 'host', fields.smtpHost);
    config.port = numberOrDefault(fields.smtpPort, 587);
    config.use_ssl = fields.smtpUseSsl;
    config.use_login_auth = fields.smtpUseLoginAuth;
    setOptionalString(config, 'from', fields.smtpFrom);
    setAddressList(config, 'to', fields.smtpTo);
    setOptionalString(config, 'subject', fields.smtpSubject);
  } else if (form.type === 'webhook') {
    setOptionalString(config, 'url', fields.webhookUrl);
    setOptionalString(config, 'method', fields.webhookMethod);
    config.headers = parseOptionalJsonObject(fields.webhookHeadersText);
    setOptionalString(config, 'idempotencyHeader', fields.webhookIdempotencyHeader);
  }

  return config;
}

function channelSecretsFromForm(form: ChannelFormState): JsonRecord {
  const secrets = parseOptionalJsonObject(form.secretsText);
  const fields = form.fields;

  if (form.type === 'telegram') {
    setOptionalString(secrets, 'botToken', fields.telegramBotToken);
  } else if (form.type === 'resend') {
    setOptionalString(secrets, 'apiKey', fields.resendApiKey);
  } else if (form.type === 'smtp') {
    setOptionalString(secrets, 'user', fields.smtpUser);
    setOptionalString(secrets, 'pass', fields.smtpPass);
  } else if (form.type === 'webhook') {
    const headers = parseOptionalJsonObject(fields.webhookSecretHeadersText);

    if (Object.keys(headers).length > 0) {
      secrets.headers = headers;
    }
  }

  return stripEmptyStrings(secrets);
}

function setOptionalString(target: JsonRecord, key: string, value: string): void {
  const trimmed = value.trim();

  if (trimmed.length > 0) {
    target[key] = trimmed;
  } else {
    delete target[key];
  }
}

function setAddressList(target: JsonRecord, key: string, value: string): void {
  const addresses = splitLinesAndCommas(value);

  if (addresses.length === 0) {
    delete target[key];
  } else {
    target[key] = addresses.length === 1 ? addresses[0] : addresses;
  }
}

function setTriStateBoolean(target: JsonRecord, key: string, value: TriStateBoolean): void {
  if (value === '') {
    delete target[key];
  } else {
    target[key] = value === 'true';
  }
}

function splitLinesAndCommas(value: string): string[] {
  return value
    .split(/[\n,]/u)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function stringFromJson(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function numberFromJson(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function numberOrDefault(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function booleanFromJson(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function triStateFromJson(value: unknown, fallback: TriStateBoolean): TriStateBoolean {
  return typeof value === 'boolean' ? (value ? 'true' : 'false') : fallback;
}

function addressTextFromJson(value: unknown, fallback: string): string {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value.join('\n');
  }

  return fallback;
}

function jsonRecordFromJson(value: unknown): JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function stripEmptyStrings(value: JsonRecord): JsonRecord {
  const stripped: JsonRecord = {};

  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string' || entry.trim().length > 0) {
      stripped[key] = entry;
    }
  }

  return stripped;
}

function optionalText(value: string): string | undefined {
  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : undefined;
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function formatTime(value: number | null | undefined): string {
  if (!value) {
    return '';
  }

  return new Date(value).toLocaleString();
}

function dateInputToUnixMs(value: string): number | undefined {
  if (value.length === 0) {
    return undefined;
  }

  const timestamp = new Date(value).getTime();

  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function isMutatingRequest(method: string | undefined): boolean {
  const normalized = method?.toUpperCase() ?? 'GET';

  return normalized !== 'GET' && normalized !== 'HEAD' && normalized !== 'OPTIONS';
}

function cookieValue(name: string): string | undefined {
  const prefix = `${encodeURIComponent(name)}=`;
  const cookie = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));

  return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : undefined;
}

function initialLocale(): Locale {
  try {
    const stored = localStorage.getItem(languageStorageKey);

    return isLocale(stored) ? stored : defaultLocale;
  } catch {
    return defaultLocale;
  }
}

function initialTab(): Tab {
  try {
    const stored = sessionStorage.getItem(activeTabStorageKey);

    return isTab(stored) ? stored : 'dashboard';
  } catch {
    return 'dashboard';
  }
}

function isTab(value: string | null): value is Tab {
  return value !== null && (tabs as readonly string[]).includes(value);
}

function isStatusKey(status: string): status is StatusKey {
  return status in messages.en.status;
}
