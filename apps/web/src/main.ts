import { createApp, onMounted, reactive } from 'vue';

import './styles.css';

type JsonRecord = Record<string, unknown>;

interface SourceRow {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  config: JsonRecord;
  hasSecret: boolean;
  webhookPath: string;
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

const tabs = ['dashboard', 'sources', 'channels', 'rules', 'outbox', 'sent-log'] as const;
type Tab = (typeof tabs)[number];

const app = createApp({
  setup() {
    const state = reactive({
      initialized: false,
      authenticated: false,
      password: '',
      activeTab: 'dashboard' as Tab,
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
      previewResult: '',
      sourceForm: {
        id: '',
        name: '',
        type: 'generic',
        enabled: true,
        configText: pretty({
          inboundDedupePath: '$.id',
          eventTypePath: '$.eventType',
        }),
        secretsText: '{}',
      },
      channelForm: {
        id: '',
        name: '',
        type: 'telegram',
        enabled: true,
        configText: pretty({
          chatId: '',
        }),
        secretsText: pretty({
          botToken: '',
        }),
        testText: 'Test message from Kaname Relay',
      },
      ruleForm: {
        id: '',
        sourceId: '',
        name: '',
        enabled: true,
        priority: 0,
        matchText: pretty({
          op: 'eq',
          path: '$.eventType',
          value: 'demo',
        }),
        templateText: pretty({
          text: 'Hello {{payload.name}}',
          title: '{{eventType}}',
        }),
        channelIdsText: '',
        samplePayloadText: pretty({
          id: 'evt-1',
          eventType: 'demo',
          name: 'Ada',
        }),
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
        state.error = error instanceof Error ? error.message : 'Request failed';
      } finally {
        state.loading = false;
      }
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
      await loadTab(tab);
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
        await request('/api/admin/sources', {
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
        await loadSources();
      }, 'Source saved');
    }

    function editSource(source: SourceRow): void {
      state.sourceForm = {
        id: source.id,
        name: source.name,
        type: source.type,
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
      }, 'Source updated');
    }

    async function loadChannels(): Promise<void> {
      const data = await request<{ channels: ChannelRow[] }>('/api/admin/channels');
      state.channels = data.channels;
    }

    async function saveChannel(): Promise<void> {
      await run(async () => {
        await request('/api/admin/channels', {
          method: 'POST',
          body: JSON.stringify({
            id: optionalText(state.channelForm.id),
            name: state.channelForm.name,
            type: state.channelForm.type,
            enabled: state.channelForm.enabled,
            config: parseJsonObject(state.channelForm.configText),
            secrets: parseJsonObject(state.channelForm.secretsText),
          }),
        });
        await loadChannels();
      }, 'Channel saved');
    }

    function editChannel(channel: ChannelRow): void {
      state.channelForm = {
        id: channel.id,
        name: channel.name,
        type: channel.type,
        enabled: channel.enabled,
        configText: pretty(channel.config),
        secretsText: '{}',
        testText: state.channelForm.testText,
      };
    }

    async function patchChannel(enabled?: boolean): Promise<void> {
      await run(async () => {
        await request(`/api/admin/channels/${state.channelForm.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            name: state.channelForm.name,
            type: state.channelForm.type,
            enabled: enabled ?? state.channelForm.enabled,
            config: parseJsonObject(state.channelForm.configText),
          }),
        });
        await loadChannels();
      }, 'Channel updated');
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
      }, 'Test sent');
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
            match: parseJsonObject(state.ruleForm.matchText),
            template: parseJsonObject(state.ruleForm.templateText),
            channelIds: splitList(state.ruleForm.channelIdsText),
          }),
        });
        await loadRules();
      }, 'Rule saved');
    }

    function editRule(rule: RuleRow): void {
      state.ruleForm = {
        id: rule.id,
        sourceId: rule.sourceId ?? '',
        name: rule.name,
        enabled: rule.enabled,
        priority: rule.priority,
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
            match: parseJsonObject(state.ruleForm.matchText),
            template: parseJsonObject(state.ruleForm.templateText),
            channelIds: splitList(state.ruleForm.channelIdsText),
          }),
        });
        await loadRules();
      }, 'Rule updated');
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
      const query = state.outboxStatus ? `?status=${encodeURIComponent(state.outboxStatus)}` : '';
      const data = await request<{ outbox: OutboxRow[] }>(`/api/admin/outbox${query}`);
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
      }, 'Replay queued');
    }

    async function cancelOutbox(id: string): Promise<void> {
      await run(async () => {
        await request(`/api/admin/outbox/${id}/cancel`, { method: 'POST' });
        await loadOutbox();
      }, 'Outbox cancelled');
    }

    async function loadSentLog(): Promise<void> {
      const data = await request<{ sentLog: SentLogRow[] }>('/api/admin/sent-log');
      state.sentLog = data.sentLog;
    }

    function webhookUrl(path: string): string {
      return `${window.location.origin}${path}`;
    }

    onMounted(() => {
      void refreshStatus();
    });

    return {
      tabs,
      state,
      setTab,
      submitAuth,
      logout,
      saveSource,
      editSource,
      patchSource,
      saveChannel,
      editChannel,
      patchChannel,
      testChannel,
      saveRule,
      editRule,
      patchRule,
      previewRule,
      loadOutbox,
      selectOutbox,
      replayOutbox,
      cancelOutbox,
      webhookUrl,
      pretty,
      formatTime,
    };
  },
  template: `
    <main v-if="!state.authenticated" class="auth">
      <section class="auth-panel">
        <div class="auth-brand">
          <span class="auth-logo"></span>
          <h1>Kaname Relay</h1>
          <p>Webhook relay console</p>
        </div>
        <form class="panel-body" @submit.prevent="submitAuth">
          <label>
            Password
            <input v-model="state.password" type="password" autocomplete="current-password" />
          </label>
          <button class="primary" type="submit" :disabled="state.loading">
            {{ state.initialized ? 'Login' : 'Initialize' }}
          </button>
          <div v-if="state.error" class="notice error">{{ state.error }}</div>
        </form>
      </section>
    </main>

    <main v-else class="app-shell">
      <header class="topbar">
        <div class="brand">
          <h1>Kaname Relay</h1>
          <span>Webhook relay console</span>
        </div>
        <button @click="logout">Logout</button>
      </header>

      <nav class="nav">
        <button
          v-for="tab in tabs"
          :key="tab"
          :class="{ active: state.activeTab === tab }"
          @click="setTab(tab)"
        >
          {{ tab }}
        </button>
      </nav>

      <section class="page">
        <div v-if="state.notice" class="notice">{{ state.notice }}</div>
        <div v-if="state.error" class="notice error">{{ state.error }}</div>

        <template v-if="state.activeTab === 'dashboard'">
          <section class="metrics">
            <div class="metric"><span>Received 24h</span><strong>{{ state.dashboard.receivedLast24h }}</strong></div>
            <div class="metric metric--pending"><span>Pending</span><strong>{{ state.dashboard.outboxByStatus.pending }}</strong></div>
            <div class="metric metric--sending"><span>Sending</span><strong>{{ state.dashboard.outboxByStatus.sending }}</strong></div>
            <div class="metric metric--sent"><span>Sent</span><strong>{{ state.dashboard.outboxByStatus.sent }}</strong></div>
            <div class="metric metric--dead"><span>Dead</span><strong>{{ state.dashboard.outboxByStatus.dead }}</strong></div>
            <div class="metric metric--cancelled"><span>Cancelled</span><strong>{{ state.dashboard.outboxByStatus.cancelled }}</strong></div>
          </section>
          <section class="panel">
            <div class="panel-header"><h2>Recent Errors</h2></div>
            <div class="table-wrap">
              <table>
                <thead><tr><th>ID</th><th>Status</th><th>Error</th><th>Updated</th></tr></thead>
                <tbody>
                  <tr v-for="item in state.dashboard.recentErrors" :key="item.id">
                    <td class="mono">{{ item.id }}</td>
                    <td><span class="status" :class="item.status">{{ item.status }}</span></td>
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
              <div class="panel-header"><h2>Source</h2></div>
              <div class="panel-body form-grid">
                <label><span>ID</span><input v-model="state.sourceForm.id" /></label>
                <label><span>Name</span><input v-model="state.sourceForm.name" /></label>
                <label><span>Type</span><input v-model="state.sourceForm.type" /></label>
                <label><span>Enabled</span><select v-model="state.sourceForm.enabled"><option :value="true">true</option><option :value="false">false</option></select></label>
                <label class="wide"><span>Config JSON</span><textarea v-model="state.sourceForm.configText"></textarea></label>
                <label class="wide"><span>Secret JSON</span><textarea v-model="state.sourceForm.secretsText"></textarea></label>
                <div class="actions wide">
                  <button class="primary" type="submit">Create</button>
                  <button type="button" @click="patchSource()">Update</button>
                  <button type="button" @click="patchSource(false)">Disable</button>
                </div>
              </div>
            </form>
            <section class="panel">
              <div class="panel-header"><h2>Sources</h2></div>
              <div class="table-wrap">
                <table>
                  <thead><tr><th>Name</th><th>Type</th><th>Webhook</th><th>Secret</th><th></th></tr></thead>
                  <tbody>
                    <tr v-for="source in state.sources" :key="source.id">
                      <td>{{ source.name }}<br /><span class="muted mono">{{ source.id }}</span></td>
                      <td>{{ source.type }}</td>
                      <td class="mono">{{ webhookUrl(source.webhookPath) }}</td>
                      <td>{{ source.hasSecret ? 'set' : 'empty' }}</td>
                      <td><button @click="editSource(source)">Edit</button></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>
          </section>
        </template>

        <template v-if="state.activeTab === 'channels'">
          <section class="split">
            <form class="panel" @submit.prevent="saveChannel">
              <div class="panel-header"><h2>Channel</h2></div>
              <div class="panel-body form-grid">
                <label><span>ID</span><input v-model="state.channelForm.id" /></label>
                <label><span>Name</span><input v-model="state.channelForm.name" /></label>
                <label><span>Type</span><input v-model="state.channelForm.type" /></label>
                <label><span>Enabled</span><select v-model="state.channelForm.enabled"><option :value="true">true</option><option :value="false">false</option></select></label>
                <label class="wide"><span>Config JSON</span><textarea v-model="state.channelForm.configText"></textarea></label>
                <label class="wide"><span>Secret JSON</span><textarea v-model="state.channelForm.secretsText"></textarea></label>
                <label class="wide"><span>Test Text</span><input v-model="state.channelForm.testText" /></label>
                <div class="actions wide">
                  <button class="primary" type="submit">Create</button>
                  <button type="button" @click="patchChannel()">Update</button>
                  <button type="button" @click="testChannel()">Test</button>
                </div>
              </div>
            </form>
            <section class="panel">
              <div class="panel-header"><h2>Channels</h2></div>
              <div class="table-wrap">
                <table>
                  <thead><tr><th>Name</th><th>Type</th><th>Enabled</th><th>Secret</th><th></th></tr></thead>
                  <tbody>
                    <tr v-for="channel in state.channels" :key="channel.id">
                      <td>{{ channel.name }}<br /><span class="muted mono">{{ channel.id }}</span></td>
                      <td>{{ channel.type }}</td>
                      <td>{{ channel.enabled }}</td>
                      <td>{{ channel.hasSecret ? 'set' : 'empty' }}</td>
                      <td class="actions"><button @click="editChannel(channel)">Edit</button><button @click="testChannel(channel.id)">Test</button></td>
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
              <div class="panel-header"><h2>Rule</h2></div>
              <div class="panel-body form-grid">
                <label><span>ID</span><input v-model="state.ruleForm.id" /></label>
                <label><span>Name</span><input v-model="state.ruleForm.name" /></label>
                <label><span>Source ID</span><input v-model="state.ruleForm.sourceId" /></label>
                <label><span>Priority</span><input v-model.number="state.ruleForm.priority" type="number" /></label>
                <label class="wide"><span>Match JSON</span><textarea v-model="state.ruleForm.matchText"></textarea></label>
                <label class="wide"><span>Template JSON</span><textarea v-model="state.ruleForm.templateText"></textarea></label>
                <label class="wide"><span>Channel IDs</span><input v-model="state.ruleForm.channelIdsText" /></label>
                <label class="wide"><span>Sample Payload</span><textarea v-model="state.ruleForm.samplePayloadText"></textarea></label>
                <div class="actions wide">
                  <button class="primary" type="submit">Create</button>
                  <button type="button" @click="patchRule()">Update</button>
                  <button type="button" @click="previewRule()">Preview</button>
                </div>
                <pre v-if="state.previewResult" class="wide">{{ state.previewResult }}</pre>
              </div>
            </form>
            <section class="panel">
              <div class="panel-header"><h2>Rules</h2></div>
              <div class="table-wrap">
                <table>
                  <thead><tr><th>Name</th><th>Source</th><th>Priority</th><th>Channels</th><th></th></tr></thead>
                  <tbody>
                    <tr v-for="rule in state.rules" :key="rule.id">
                      <td>{{ rule.name }}<br /><span class="muted mono">{{ rule.id }}</span></td>
                      <td class="mono">{{ rule.sourceId }}</td>
                      <td>{{ rule.priority }}</td>
                      <td class="mono">{{ rule.channelIds.join(', ') }}</td>
                      <td><button @click="editRule(rule)">Edit</button></td>
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
              <h2>Outbox</h2>
              <div class="actions">
                <select v-model="state.outboxStatus" @change="loadOutbox">
                  <option value="">all</option>
                  <option value="pending">pending</option>
                  <option value="sending">sending</option>
                  <option value="sent">sent</option>
                  <option value="dead">dead</option>
                  <option value="cancelled">cancelled</option>
                </select>
                <button @click="loadOutbox">Refresh</button>
              </div>
            </div>
            <div class="table-wrap">
              <table>
                <thead><tr><th>ID</th><th>Status</th><th>Channel</th><th>Attempts</th><th>Error</th><th></th></tr></thead>
                <tbody>
                  <tr v-for="item in state.outbox" :key="item.id">
                    <td class="mono">{{ item.id }}</td>
                    <td><span class="status" :class="item.status">{{ item.status }}</span></td>
                    <td class="mono">{{ item.channelId }}</td>
                    <td>{{ item.attempts }} / {{ item.maxAttempts }}</td>
                    <td>{{ item.lastError }}</td>
                    <td class="actions">
                      <button @click="selectOutbox(item.id)">View</button>
                      <button v-if="item.status === 'dead' || item.status === 'cancelled'" @click="replayOutbox(item.id)">Replay</button>
                      <button v-if="item.status === 'pending' || item.status === 'sending'" class="danger" @click="cancelOutbox(item.id)">Cancel</button>
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
            <div class="panel-header"><h2>Sent Log</h2><button @click="loadSentLog">Refresh</button></div>
            <div class="table-wrap">
              <table>
                <thead><tr><th>ID</th><th>Outbox</th><th>Channel</th><th>Provider</th><th>Sent</th></tr></thead>
                <tbody>
                  <tr v-for="entry in state.sentLog" :key="entry.id">
                    <td class="mono">{{ entry.id }}</td>
                    <td class="mono">{{ entry.outboxId }}</td>
                    <td class="mono">{{ entry.channelId }}</td>
                    <td>{{ entry.providerMessageId }}</td>
                    <td>{{ formatTime(entry.sentAt) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
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
