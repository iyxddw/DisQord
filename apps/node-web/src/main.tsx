import { StrictMode, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Clock3,
  FileClock,
  KeyRound,
  Link2,
  RefreshCw,
  Save,
  Server,
  Settings,
  ShieldCheck,
} from 'lucide-react';

import './styles.css';

interface Status {
  program: 'qq-node' | 'discord-node';
  configured: boolean;
  state: 'setup' | 'starting' | 'connected' | 'retrying' | 'stopped';
  detail?: string;
  centralUrl: string;
  platformConnected: boolean;
  startedAt: string;
  logPath?: string;
  configuration?: {
    centralUrl: string;
    platformUrl?: string;
    allowInsecureCentral: boolean;
    platformTokenConfigured: boolean;
  };
}

interface NodeLogRecord {
  createdAt: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  event: string;
  details?: Record<string, unknown>;
}

interface NodeLogPage {
  items: NodeLogRecord[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

type NodeSection = 'overview' | 'diagnostics' | 'logs' | 'access';

function App() {
  const [status, setStatus] = useState<Status>();
  const [error, setError] = useState('');
  const [statusLoading, setStatusLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [token, setToken] = useState(sessionStorage.getItem('node-token') ?? '');
  const [logs, setLogs] = useState<NodeLogPage>({
    items: [],
    page: 1,
    pageSize: 50,
    total: 0,
    totalPages: 1,
  });
  const [logLevel, setLogLevel] = useState('all');
  const [logSearch, setLogSearch] = useState('');
  const [logPage, setLogPage] = useState(1);
  const [logError, setLogError] = useState('');
  const [logsLoading, setLogsLoading] = useState(true);
  const [activeSection, setActiveSection] = useState<NodeSection>('overview');
  const load = async (background = false) => {
    if (!background) setStatusLoading(true);
    try {
      const response = await fetch('/api/node/status', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok)
        throw new Error(response.status === 401 ? '需要节点面板令牌' : '读取状态失败');
      setStatus((await response.json()) as Status);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '节点不可用');
    } finally {
      if (!background) setStatusLoading(false);
    }
  };
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(true), 5000);
    return () => clearInterval(timer);
  }, [token]);
  useEffect(() => {
    const loadLogs = async (background = false) => {
      if (status?.configured === false) {
        setLogsLoading(false);
        setLogError('');
        return;
      }
      if (!background) setLogsLoading(true);
      try {
        const query = new URLSearchParams({
          page: String(logPage),
          pageSize: '50',
          level: logLevel,
          search: logSearch,
        });
        const response = await fetch(`/api/node/logs?${query.toString()}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!response.ok)
          throw new Error(response.status === 401 ? '需要节点面板令牌' : '读取日志失败');
        setLogs((await response.json()) as NodeLogPage);
        setLogError('');
      } catch (cause) {
        setLogError(cause instanceof Error ? cause.message : '读取日志失败');
      } finally {
        if (!background) setLogsLoading(false);
      }
    };
    void loadLogs();
    const timer = setInterval(() => void loadLogs(true), 5000);
    return () => clearInterval(timer);
  }, [logLevel, logPage, logSearch, status?.configured, token]);
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.find((entry) => entry.isIntersecting);
        if (visible) setActiveSection(visible.target.id as NodeSection);
      },
      { rootMargin: '-20% 0px -65% 0px' },
    );
    for (const id of ['overview', 'diagnostics', 'logs', 'access'] as const) {
      const element = document.querySelector(`#${id}`);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, []);
  const saveToken = (value: string) => {
    setToken(value);
    sessionStorage.setItem('node-token', value);
  };
  const refresh = async () => {
    setRefreshing(true);
    try {
      const response = await fetch('/api/node/refresh', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) throw new Error('刷新会话列表失败');
      await load(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '刷新会话列表失败');
    } finally {
      setRefreshing(false);
    }
  };

  const nodeName = status?.program === 'discord-node' ? 'Discord 消息节点' : 'QQ 消息节点';
  const nodeKind = status?.program === 'discord-node' ? 'Discord Node' : 'QQ / NapCat Node';

  if (!status && error === '需要节点面板令牌') {
    return <NodeAccessGuide token={token} onTokenChange={saveToken} />;
  }
  if (status && !status.configured) {
    return <NodeSetupGuide status={status} token={token} />;
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <Link2 className="brand-symbol" size={22} />
          <div>
            <strong>DisQord</strong>
            <span>客户端控制台</span>
          </div>
        </div>
        <nav aria-label="客户端功能区">
          <a
            className={activeSection === 'overview' ? 'active' : ''}
            href="#overview"
            onClick={() => setActiveSection('overview')}
          >
            <Activity size={18} />
            <span>运行状态</span>
          </a>
          <a
            className={activeSection === 'diagnostics' ? 'active' : ''}
            href="#diagnostics"
            onClick={() => setActiveSection('diagnostics')}
          >
            <ShieldCheck size={18} />
            <span>连接诊断</span>
          </a>
          <a
            className={activeSection === 'logs' ? 'active' : ''}
            href="#logs"
            onClick={() => setActiveSection('logs')}
          >
            <FileClock size={18} />
            <span>客户端日志</span>
          </a>
          <a
            className={activeSection === 'access' ? 'active' : ''}
            href="#access"
            onClick={() => setActiveSection('access')}
          >
            <Settings size={18} />
            <span>访问设置</span>
          </a>
        </nav>
        <div className="sidebar-foot">
          <span>
            <i className={status?.state === 'connected' ? 'online' : ''} />
            {stateLabel(status?.state)}
          </span>
          <small>{nodeKind}</small>
        </div>
      </aside>

      <main className="workspace">
        <header>
          <h1>{nodeName}</h1>
          <div className="header-status">
            <ShieldCheck size={17} />
            平台凭据与消息队列仅保存在本机
          </div>
        </header>

        <section className="page">
          <section className="overview-summary" id="overview">
            <div>
              <span className="section-kicker">{nodeKind}</span>
              <h2>客户端运行概览</h2>
              <p>中央服务负责翻译、审核和卡片编排，当前页面只展示本机节点状态。</p>
            </div>
            <div className={`system-state ${status?.state === 'connected' ? 'online' : ''}`}>
              <i />
              {statusLoading ? '正在读取状态' : stateLabel(status?.state)}
            </div>
          </section>

          {error && (
            <div className="alert">
              <CircleAlert size={18} />
              <div>
                <strong>{error}</strong>
                <span>如果面板对外开放，请填写 NODE_WEB_TOKEN。</span>
              </div>
            </div>
          )}

          <dl className="overview-metrics">
            <Metric
              icon={Server}
              title="中央服务"
              value={status?.centralUrl ?? '等待配置'}
              hint="节点主动建立安全连接"
            />
            <Metric
              icon={Activity}
              title="平台连接"
              value={status?.platformConnected ? '已连接' : '未连接'}
              hint={
                status?.program === 'discord-node' ? 'Discord Gateway' : 'NapCat OneBot WebSocket'
              }
            />
            <Metric
              icon={Clock3}
              title="启动时间"
              value={
                status ? new Date(status.startedAt).toLocaleString('zh-CN', { hour12: false }) : '—'
              }
              hint="状态每 5 秒自动刷新"
            />
          </dl>

          <section className="panel" id="diagnostics">
            <PanelHead
              title="连接诊断"
              subtitle="不会显示机器人 Token、配对密钥或消息正文。"
              action={
                <button className="secondary" disabled={refreshing} onClick={() => void refresh()}>
                  <RefreshCw className={refreshing ? 'spin' : ''} size={16} />
                  {refreshing ? '刷新中' : '刷新会话列表'}
                </button>
              }
            />
            <div className="checks">
              <Check label="节点程序已启动" ok={Boolean(status)} />
              <Check label="平台适配器已连接" ok={Boolean(status?.platformConnected)} />
              <Check label="中央安全通道已认证" ok={status?.state === 'connected'} />
            </div>
            {status?.detail && <pre>{status.detail}</pre>}
          </section>

          <section className="panel node-logs" id="logs">
            <PanelHead
              title="客户端日志"
              subtitle={`本机 JSONL 日志：${status?.logPath ?? '等待启动'}`}
              action={
                <div className="log-controls">
                  <input
                    placeholder="搜索日志"
                    value={logSearch}
                    onChange={(event) => {
                      setLogSearch(event.target.value);
                      setLogPage(1);
                    }}
                  />
                  <select
                    value={logLevel}
                    onChange={(event) => {
                      setLogLevel(event.target.value);
                      setLogPage(1);
                    }}
                  >
                    <option value="all">全部级别</option>
                    <option value="debug">Debug</option>
                    <option value="info">Info</option>
                    <option value="warn">Warn</option>
                    <option value="error">Error</option>
                  </select>
                </div>
              }
            />
            {logError && <div className="alert compact">{logError}</div>}
            {logsLoading && <LoadingProgress text="正在读取客户端日志" />}
            <div className="node-log-list">
              {logs.items.map((record, index) => (
                <article
                  className={`node-log ${record.level}`}
                  key={`${record.createdAt}-${index}`}
                >
                  <div>
                    <strong>{translateLogEvent(record.event)}</strong>
                    <span>{record.level.toUpperCase()}</span>
                    <time>
                      {new Date(record.createdAt).toLocaleString('zh-CN', { hour12: false })}
                    </time>
                  </div>
                  {record.details && <pre>{JSON.stringify(record.details, null, 2)}</pre>}
                </article>
              ))}
              {!logs.items.length && !logError && !logsLoading && (
                <p className="empty">暂无匹配日志</p>
              )}
            </div>
            {logs.totalPages > 1 && (
              <div className="node-log-pagination">
                <span>
                  第 {logs.page} / {logs.totalPages} 页 · 共 {logs.total} 条
                </span>
                <div>
                  <button
                    disabled={logs.page <= 1}
                    onClick={() => setLogPage((current) => Math.max(1, current - 1))}
                  >
                    上一页
                  </button>
                  <button
                    disabled={logs.page >= logs.totalPages}
                    onClick={() => setLogPage((current) => Math.min(logs.totalPages, current + 1))}
                  >
                    下一页
                  </button>
                </div>
              </div>
            )}
          </section>

          <section className="panel token-panel" id="access">
            <div>
              <KeyRound size={19} />
              <div>
                <h2>面板访问令牌</h2>
                <p>仅当面板监听非本机地址时需要；内容只保存在当前浏览器会话。</p>
              </div>
            </div>
            <input
              type="password"
              placeholder="NODE_WEB_TOKEN"
              value={token}
              onChange={(event) => saveToken(event.target.value)}
            />
          </section>
        </section>
      </main>
    </div>
  );
}

function NodeAccessGuide({
  token,
  onTokenChange,
}: {
  token: string;
  onTokenChange: (value: string) => void;
}) {
  return (
    <div className="node-setup-page">
      <section className="node-setup-shell access-gate">
        <div className="setup-brand">
          <Link2 size={20} />
          <div>
            <strong>DisQord</strong>
            <span>客户端首次启动</span>
          </div>
        </div>
        <span className="setup-step">步骤 1 / 2</span>
        <h1>验证本机管理令牌</h1>
        <p>安装脚本已在完成摘要中显示该令牌。它只用于保护当前节点面板，不是中央配对密钥。</p>
        <label>
          节点面板令牌
          <input
            autoFocus
            type="password"
            placeholder="NODE_WEB_TOKEN"
            value={token}
            onChange={(event) => onTokenChange(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && location.reload()}
          />
        </label>
        <button className="primary" disabled={token.length < 16} onClick={() => location.reload()}>
          继续 <ChevronRight size={16} />
        </button>
      </section>
    </div>
  );
}

function NodeSetupGuide({ status, token }: { status: Status; token: string }) {
  const discord = status.program === 'discord-node';
  const configuration = status.configuration;
  const [centralUrl, setCentralUrl] = useState(configuration?.centralUrl ?? '');
  const [platformUrl, setPlatformUrl] = useState(
    configuration?.platformUrl ?? 'ws://127.0.0.1:3001',
  );
  const [platformToken, setPlatformToken] = useState('');
  const [allowInsecure, setAllowInsecure] = useState(configuration?.allowInsecureCentral ?? false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setSaving(true);
    setError('');
    try {
      const response = await fetch('/api/node/setup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          centralUrl: centralUrl.trim(),
          allowInsecureCentral: allowInsecure,
          ...(discord
            ? { discordBotToken: platformToken.trim() || undefined }
            : {
                napcatUrl: platformUrl.trim(),
                napcatAccessToken: platformToken.trim() || undefined,
              }),
        }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        restartRequired?: boolean;
      };
      if (!response.ok) throw new Error(body.error ?? '配置保存失败');
      setRestartRequired(Boolean(body.restartRequired));
      setSaved(true);
      if (body.restartRequired) window.setTimeout(() => location.reload(), 3_000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '配置保存失败');
    } finally {
      setSaving(false);
    }
  };

  if (saved) {
    return (
      <div className="node-setup-page">
        <section className="node-setup-shell setup-finished">
          <CheckCircle2 size={25} />
          <span className="setup-step">配置已保存</span>
          <h1>{restartRequired ? '客户端正在重启' : '请重新启动客户端'}</h1>
          <p>
            {restartRequired
              ? 'PM2 会自动重新加载刚才保存的配置，本页面将在几秒后刷新。'
              : '当前不是由安装脚本的 PM2 模式启动，请手动重启节点后刷新页面。'}
          </p>
          {restartRequired && <LoadingProgress text="正在等待客户端恢复连接" />}
          <button onClick={() => location.reload()}>立即刷新</button>
        </section>
      </div>
    );
  }

  const tokenRequired = discord && !configuration?.platformTokenConfigured;
  return (
    <div className="node-setup-page">
      <section className="node-setup-shell">
        <div className="setup-brand">
          <Link2 size={20} />
          <div>
            <strong>DisQord</strong>
            <span>{discord ? 'Discord 客户端' : 'QQ 客户端'}首次启动</span>
          </div>
        </div>
        <span className="setup-step">步骤 2 / 2</span>
        <h1>连接中央服务和消息平台</h1>
        <p>配置会以受限权限保存在当前服务器，不会返回到浏览器或中央端。</p>
        <div className="node-setup-form">
          <label>
            中央 WebSocket 地址
            <input
              autoFocus
              placeholder="wss://central.example.com/node"
              value={centralUrl}
              onChange={(event) => setCentralUrl(event.target.value)}
            />
            <small>生产环境使用 wss://；直接测试 HTTP 服务时才使用 ws://。</small>
          </label>
          {!discord && (
            <label>
              NapCat OneBot WebSocket 地址
              <input
                placeholder="ws://127.0.0.1:3001"
                value={platformUrl}
                onChange={(event) => setPlatformUrl(event.target.value)}
              />
            </label>
          )}
          <label>
            {discord ? 'Discord Bot Token' : 'NapCat Access Token（可选）'}
            <input
              type="password"
              placeholder={
                configuration?.platformTokenConfigured ? '已保存；留空表示不修改' : '填写平台凭据'
              }
              value={platformToken}
              onChange={(event) => setPlatformToken(event.target.value)}
            />
          </label>
          <label className="setup-checkbox">
            <input
              type="checkbox"
              checked={allowInsecure}
              onChange={(event) => setAllowInsecure(event.target.checked)}
            />
            <span>
              <strong>允许不安全的中央连接</strong>
              <small>仅当使用 ws:// 进行局域网或本机测试时开启。</small>
            </span>
          </label>
        </div>
        {error && (
          <div className="alert compact">
            <CircleAlert size={16} />
            <span>{error}</span>
          </div>
        )}
        {saving && <LoadingProgress text="正在验证并保存客户端配置" />}
        <button
          className="primary setup-submit"
          disabled={saving || !centralUrl.trim() || (tokenRequired && !platformToken.trim())}
          onClick={() => void submit()}
        >
          <Save size={16} /> 保存并启动客户端
        </button>
      </section>
    </div>
  );
}

function Metric({
  icon: Icon,
  title,
  value,
  hint,
}: {
  icon: typeof Server;
  title: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="metric">
      <dt>
        <Icon size={16} />
        {title}
      </dt>
      <dd>{value}</dd>
      <small>{hint}</small>
    </div>
  );
}
function PanelHead({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle: string;
  action?: ReactNode;
}) {
  return (
    <div className="panel-head">
      <div>
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>
      {action}
    </div>
  );
}
function LoadingProgress({ text }: { text: string }) {
  return (
    <div className="loading-progress" role="status" aria-live="polite">
      <span>{text}</span>
      <div aria-hidden="true">
        <i />
      </div>
    </div>
  );
}
function Check({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div className={ok ? 'ok' : ''}>
      {ok ? <CheckCircle2 size={18} /> : <CircleAlert size={18} />}
      <span>{label}</span>
      <b>{ok ? '正常' : '等待'}</b>
    </div>
  );
}
function stateLabel(state?: Status['state']) {
  return {
    setup: '等待配置',
    starting: '启动中',
    connected: '运行正常',
    retrying: '正在重连',
    stopped: '已停止',
  }[state ?? 'starting'];
}

const logEventLabels: Record<string, string> = {
  runtime_starting: '节点启动',
  runtime_stopped: '节点已停止',
  runtime_retrying: '节点重试连接',
  central_connected: '已连接中央服务',
  pairing_started: '开始配对',
  pairing_completed: '配对完成',
  session_candidates_ready: '会话列表已更新',
  verification_requested: '收到验证请求',
  verification_sent: '验证码已发送',
  message_queued: '消息已加入队列',
  message_upload_attempt_started: '开始上传消息',
  message_upload_acknowledged: '消息上传已确认',
  message_upload_batch_acknowledged: '批量消息上传已确认',
  message_upload_batch_accepted: '批量消息已持久化，后台处理中',
  message_upload_batch_processing: '批量消息后台处理中',
  message_upload_batch_completed: '批量消息后台处理完成',
  message_upload_batch_retry_scheduled: '批量消息将自动重试',
  message_upload_batch_retry_exhausted: '批量消息重试次数已用尽',
  message_upload_batch_deduplicated: '批量消息已去重',
  message_upload_batch_processed: '批量消息处理完成',
  message_upload_batch_deliveries_queued: '批量发送任务已加入队列',
  message_upload_batch_failed: '批量消息处理失败',
  message_upload_batch_window_scheduled: '批量上传等待窗口已安排',
  message_upload_retry_scheduled: '消息上传将重试',
  message_upload_dead_letter: '消息上传进入死信队列',
  delivery_queued: '发送任务已加入队列',
  delivery_batch_queued: '批量发送任务已加入队列',
  delivery_batch_item_failed: '批量发送中的消息失败',
  delivery_interval_scheduled: '已安排下一条消息的发送间隔',
  delivery_attempt_started: '开始发送消息',
  delivery_platform_confirmed: '平台确认发送成功',
  delivery_acknowledged_by_central: '中央服务已确认发送',
  delivery_retry_scheduled: '发送失败，将重试',
  delivery_dead_letter: '发送进入死信队列',
  delivery_recovery_failed: '恢复发送任务失败',
  delivery_failure_report_failed: '上报发送失败失败',
  node_logs_sent: '客户端日志已回传',
};

function translateLogEvent(event: string): string {
  return logEventLabels[event] ?? event.replaceAll('_', ' ');
}

const root = document.querySelector('#root');
if (!root) throw new Error('Missing #root element');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
