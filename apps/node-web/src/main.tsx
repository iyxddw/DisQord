import { StrictMode, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  CheckCircle2,
  CircleAlert,
  Clock3,
  FileClock,
  KeyRound,
  Link2,
  RefreshCw,
  Server,
  Settings,
  ShieldCheck,
} from 'lucide-react';

import './styles.css';

interface Status {
  program: 'qq-node' | 'discord-node';
  state: 'starting' | 'connected' | 'retrying' | 'stopped';
  detail?: string;
  centralUrl: string;
  platformConnected: boolean;
  startedAt: string;
  logPath?: string;
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
  }, [logLevel, logPage, logSearch, token]);
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
  return { starting: '启动中', connected: '运行正常', retrying: '正在重连', stopped: '已停止' }[
    state ?? 'starting'
  ];
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
