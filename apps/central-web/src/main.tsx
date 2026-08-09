import {
  StrictMode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createRoot } from 'react-dom/client';
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import {
  Activity,
  ArrowDown,
  ArrowRightLeft,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  FileClock,
  FlaskConical,
  Gauge,
  LogOut,
  LoaderCircle,
  MessagesSquare,
  Network,
  Palette,
  Pause,
  Pencil,
  Play,
  Plus,
  Power,
  RefreshCw,
  Save,
  Server,
  Settings,
  ShieldCheck,
  Trash2,
} from 'lucide-react';

import '@xyflow/react/dist/style.css';
import './styles.css';
import {
  api,
  apiRetry,
  type AuthStatus,
  type Blueprint,
  type BlueprintActivity,
  type BlueprintActivityPage,
  type BlueprintVersion,
  type ChatSession,
  type NodeRuntime,
  type LogPage,
} from './api';

type Page = 'overview' | 'sessions' | 'blueprint' | 'nodes' | 'settings' | 'reviews' | 'logs';

const navigation: Array<{ id: Page; label: string; icon: typeof Activity }> = [
  { id: 'overview', label: '运行概览', icon: Activity },
  { id: 'sessions', label: '聊天会话', icon: MessagesSquare },
  { id: 'blueprint', label: '转发蓝图', icon: Network },
  { id: 'nodes', label: '绑定会话', icon: Server },
  { id: 'settings', label: '基础设置', icon: Settings },
  { id: 'reviews', label: '人工审核', icon: ShieldCheck },
  { id: 'logs', label: '运行日志', icon: FileClock },
];

function sessionLabel(session: ChatSession): string {
  return session.remark?.trim() || session.displayName;
}

const pageCache = new Map<string, unknown>();
const pageRequests = new Map<string, Promise<unknown>>();

function loadCached<T>(path: string, force = false): Promise<T> {
  if (!force && pageCache.has(path)) return Promise.resolve(pageCache.get(path) as T);
  if (!force) {
    const existing = pageRequests.get(path);
    if (existing) return existing as Promise<T>;
  }
  const request = api<T>(path)
    .then((value) => {
      pageCache.set(path, value);
      return value;
    })
    .finally(() => pageRequests.delete(path));
  pageRequests.set(path, request);
  return request;
}

function useLoad<T>(path: string, fallback: T) {
  const [data, setData] = useState<T>(() => (pageCache.get(path) as T | undefined) ?? fallback);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(() => !pageCache.has(path));
  const reload = useCallback(
    async (options: { background?: boolean } = {}) => {
      if (!options.background) setLoading(true);
      try {
        setData(await loadCached<T>(path, true));
        setError('');
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '加载失败');
      } finally {
        setLoading(false);
      }
    },
    [path],
  );
  useEffect(() => {
    let active = true;
    if (!pageCache.has(path)) setLoading(true);
    void loadCached<T>(path).then(
      (value) => {
        if (!active) return;
        setData(value);
        setError('');
        setLoading(false);
      },
      (cause: unknown) => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : '加载失败');
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [path]);
  const updateData = useCallback(
    (next: T | ((current: T) => T)) => {
      setData((current) => {
        const value = typeof next === 'function' ? (next as (current: T) => T)(current) : next;
        pageCache.set(path, value);
        return value;
      });
    },
    [path],
  );
  return { data, error, loading, reload, setData: updateData, setError };
}

function App() {
  const [auth, setAuth] = useState<AuthStatus>();
  const [page, setPage] = useState<Page>('overview');
  const refreshAuth = useCallback(async () => {
    try {
      setAuth(await api<AuthStatus>('/auth/status'));
    } catch {
      setAuth({ configured: false, authenticated: false, onboardingComplete: false });
    }
  }, []);
  useEffect(() => {
    void refreshAuth();
  }, [refreshAuth]);

  useEffect(() => {
    if (!auth?.authenticated) return;
    const paths = [
      '/nodes',
      '/chat-sessions',
      '/blueprints',
      '/settings/llm',
      '/settings/card',
      '/settings/simulation',
      '/reviews',
      '/logs?page=1&pageSize=50&level=all&search=',
    ];
    for (const path of paths) void loadCached(path).catch(() => undefined);
  }, [auth?.authenticated]);

  if (!auth) return <Splash />;
  if (!auth.authenticated) {
    return <Login configured={auth.configured} onDone={refreshAuth} />;
  }
  if (!auth.onboardingComplete) {
    return (
      <CentralSetupGuide
        onDone={() => setAuth({ configured: true, authenticated: true, onboardingComplete: true })}
      />
    );
  }

  const current = navigation.find((item) => item.id === page)!;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <MessagesSquare className="brand-symbol" size={22} />
          <div>
            <strong>DisQord</strong>
            <span>跨平台消息中枢</span>
          </div>
        </div>
        <nav>
          {navigation.map((item) => {
            const Icon = item.icon;
            return (
              <button
                aria-label={item.label}
                className={page === item.id ? 'active' : ''}
                key={item.id}
                onClick={() => setPage(item.id)}
                title={item.label}
              >
                <Icon size={18} />
                <span>{item.label}</span>
                <ChevronRight className="chevron" size={15} />
              </button>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          <span>
            <i />
            中央服务已连接
          </span>
          <button
            onClick={() =>
              void api('/auth/logout', { method: 'POST' }).then(() => location.reload())
            }
          >
            <LogOut size={16} />
            退出
          </button>
        </div>
      </aside>
      <main className="workspace">
        <header>
          <h1>{current.label}</h1>
          <div className="header-status">
            <ShieldCheck size={17} />
            {location.protocol === 'https:' ? '管理连接已加密' : '管理连接使用明文 HTTP'}
          </div>
        </header>
        <section className="page">
          {page === 'overview' && <Overview />}
          {page === 'sessions' && <Sessions />}
          {page === 'blueprint' && <BlueprintEditor />}
          {page === 'nodes' && <Nodes />}
          {page === 'settings' && <SettingsPage />}
          {page === 'reviews' && <Records kind="reviews" />}
          {page === 'logs' && <Records kind="logs" />}
        </section>
      </main>
    </div>
  );
}

function Splash() {
  return (
    <div className="splash">
      <MessagesSquare className="brand-symbol" size={28} />
      <p>正在连接 DisQord…</p>
    </div>
  );
}

function Login({
  configured,
  onDone,
}: {
  configured: boolean;
  onDone: () => void | Promise<void>;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const submit = async () => {
    try {
      await api(configured ? '/auth/login' : '/auth/setup', { method: 'POST', json: { password } });
      await onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败');
    }
  };
  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <MessagesSquare className="brand-symbol" size={21} />
          <div>
            <strong>DisQord</strong>
            <span>跨平台消息中枢</span>
          </div>
        </div>
        <h1>{configured ? '登录管理面板' : '创建管理员'}</h1>
        <p>{configured ? '输入管理密码进入控制台。' : '首次启动，请设置至少 12 位管理密码。'}</p>
        <label>
          管理密码
          <input
            autoFocus
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && void submit()}
          />
        </label>
        {error && (
          <div className="panel-error">
            <CircleAlert size={15} />
            {error}
          </div>
        )}
        <button className="primary" onClick={() => void submit()}>
          {configured ? '登录控制台' : '完成初始化'}
        </button>
      </div>
    </div>
  );
}

function CentralSetupGuide({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [textModel, setTextModel] = useState('');
  const [imageModel, setImageModel] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const saveLlm = async () => {
    if (!baseUrl.trim() || !textModel.trim()) {
      setError('请填写 API 基础地址和文本模型；也可以选择稍后配置。');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await api('/settings/llm', {
        method: 'PUT',
        json: {
          providers: [
            {
              id: 'initial-provider',
              name: '默认模型',
              enabled: true,
              translationEnabled: true,
              moderationEnabled: true,
              imageModerationEnabled: Boolean(imageModel.trim()),
              baseUrl: baseUrl.trim(),
              ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
              translationModel: textModel.trim(),
              moderationModel: textModel.trim(),
              imageModerationModel: imageModel.trim(),
            },
          ],
          concurrency: 4,
          fastMode: false,
          fastDeliveryIntervalMs: 1_500,
        },
      });
      setStep(2);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '模型配置保存失败');
    } finally {
      setSaving(false);
    }
  };

  const finish = async () => {
    setSaving(true);
    setError('');
    try {
      await api('/setup/complete', { method: 'POST' });
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '初始化状态保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="setup-page">
      <section className="setup-shell">
        <div className="auth-brand">
          <MessagesSquare className="brand-symbol" size={21} />
          <div>
            <strong>DisQord</strong>
            <span>中央端首次启动</span>
          </div>
        </div>
        <div className="setup-progress" aria-label={`初始化步骤 ${step + 1}/3`}>
          {[0, 1, 2].map((index) => (
            <i className={index <= step ? 'active' : ''} key={index} />
          ))}
        </div>

        {step === 0 && (
          <div className="setup-content">
            <span className="setup-step">步骤 1 / 3</span>
            <h1>中央服务已经启动</h1>
            <p>
              管理员账号已经创建。接下来可以接入模型服务，也可以先跳过，稍后在“基础设置”中配置多个模型和故障转移顺序。
            </p>
            <div className="setup-checklist">
              <div>
                <Check size={16} />
                <span>中央数据与密钥保存在本机</span>
              </div>
              <div>
                <Check size={16} />
                <span>节点只会主动连接中央服务</span>
              </div>
              <div>
                <Check size={16} />
                <span>所有设置之后仍可修改</span>
              </div>
            </div>
            <button className="primary" onClick={() => setStep(1)}>
              继续配置模型 <ChevronRight size={16} />
            </button>
          </div>
        )}

        {step === 1 && (
          <div className="setup-content">
            <span className="setup-step">步骤 2 / 3</span>
            <h1>接入第一个模型</h1>
            <p>
              支持 OpenAI 兼容的 Chat Completions
              接口。这里只创建第一项，完成后可以继续添加备用模型。
            </p>
            <div className="setup-form">
              <label>
                API 基础地址
                <input
                  autoFocus
                  placeholder="https://api.example.com/v1"
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                />
              </label>
              <label>
                API 密钥
                <input
                  type="password"
                  placeholder="仅保存在中央端"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                />
              </label>
              <label>
                文本模型
                <input
                  placeholder="用于翻译和文本审核"
                  value={textModel}
                  onChange={(event) => setTextModel(event.target.value)}
                />
              </label>
              <label>
                图片审核模型（可选）
                <input
                  placeholder="留空表示暂不启用图片审核模型"
                  value={imageModel}
                  onChange={(event) => setImageModel(event.target.value)}
                />
              </label>
            </div>
            {error && (
              <div className="panel-error">
                <CircleAlert size={15} />
                {error}
              </div>
            )}
            {saving && <LoadingProgress text="正在保存模型配置" />}
            <div className="setup-actions">
              <button
                disabled={saving}
                onClick={() => {
                  setError('');
                  setStep(2);
                }}
              >
                稍后配置
              </button>
              <button className="primary" disabled={saving} onClick={() => void saveLlm()}>
                <Save size={16} />
                保存并继续
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="setup-content">
            <span className="setup-step">步骤 3 / 3</span>
            <h1>准备完成</h1>
            <p>进入控制台后，按顺序连接节点、验证聊天会话，再创建并发布转发蓝图。</p>
            <ol className="setup-next">
              <li>
                <strong>连接客户端</strong>
                <span>在 QQ 或 Discord 节点首次向导中填写中央 WebSocket 地址。</span>
              </li>
              <li>
                <strong>绑定会话</strong>
                <span>选择群聊或频道，并发送验证码完成验证。</span>
              </li>
              <li>
                <strong>发布蓝图</strong>
                <span>为 QQ → Discord 和 Discord → QQ 分别配置消息流。</span>
              </li>
            </ol>
            {error && (
              <div className="panel-error">
                <CircleAlert size={15} />
                {error}
              </div>
            )}
            {saving && <LoadingProgress text="正在完成初始化" />}
            <button className="primary" disabled={saving} onClick={() => void finish()}>
              进入中央控制台 <ChevronRight size={16} />
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function Overview() {
  const nodes = useLoad<NodeRuntime[]>('/nodes', []);
  const sessions = useLoad<ChatSession[]>('/chat-sessions', []);
  const reviews = useLoad<unknown[]>('/reviews', []);
  const online = nodes.data.filter((node) => node.online).length;
  if (nodes.loading || sessions.loading || reviews.loading) {
    return <LoadingState text="正在汇总运行状态" />;
  }
  return (
    <>
      <section className="overview-summary">
        <div>
          <span className="system-state">
            <i />
            {online === nodes.data.length && nodes.data.length > 0
              ? '全部客户端在线'
              : `${online} 个客户端在线`}
          </span>
          <h2>中央服务正常</h2>
          <p>节点心跳、会话和待审核消息均来自当前中央服务。</p>
        </div>
        <dl className="overview-metrics">
          <div>
            <dt>在线客户端</dt>
            <dd>
              {online} / {nodes.data.length}
            </dd>
          </div>
          <div>
            <dt>已验证会话</dt>
            <dd>{sessions.data.filter((item) => item.status === 'verified').length}</dd>
          </div>
          <div>
            <dt>等待人工审核</dt>
            <dd>
              {
                reviews.data.filter((item) => (item as { status?: string }).status === 'pending')
                  .length
              }
            </dd>
          </div>
        </dl>
      </section>
      <div className="panel">
        <PanelTitle title="客户端连接" subtitle="QQ 与 Discord 节点的当前连接状态" />
        <div className="node-grid">
          {(['qq', 'discord'] as const).map((type) => {
            const node = nodes.data.find((item) => item.nodeType === type);
            return (
              <div className="node-card" key={type}>
                <Bot className={`platform-icon ${type}`} size={18} />
                <div>
                  <strong>{type === 'qq' ? 'QQ / NapCat' : 'Discord Bot'}</strong>
                  <span>
                    {node
                      ? node.online
                        ? '客户端在线'
                        : `最后活动 ${formatTime(node.lastSeenAt)}`
                      : '等待节点首次连接'}
                  </span>
                </div>
                <b className={node?.online ? 'ok' : 'muted'}>
                  {node?.online ? '在线' : node ? '等待连接' : '未连接'}
                </b>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

function Sessions() {
  const { data, setData, reload, error, setError, loading } = useLoad<ChatSession[]>(
    '/chat-sessions',
    [],
  );
  const [editingId, setEditingId] = useState('');
  const [remark, setRemark] = useState('');
  const saveRemark = async (session: ChatSession) => {
    const nextRemark = remark.trim();
    const previous = data;
    setData((current) =>
      current.map((item) =>
        item.id === session.id
          ? nextRemark
            ? { ...item, remark: nextRemark }
            : (() => {
                const withoutRemark = { ...item };
                delete withoutRemark.remark;
                return withoutRemark;
              })()
          : item,
      ),
    );
    setEditingId('');
    try {
      await apiRetry(
        `/chat-sessions/${session.id}`,
        { method: 'PATCH', json: { remark: nextRemark || null } },
        { attempts: 3 },
      );
      setError('');
    } catch (cause) {
      setData(previous);
      setError(cause instanceof Error ? cause.message : '备注保存失败');
    }
  };
  const remove = async (session: ChatSession) => {
    if (!window.confirm(`确定删除会话“${sessionLabel(session)}”吗？引用它的蓝图需要重新编辑。`))
      return;
    const previous = data;
    setData((current) => current.filter((item) => item.id !== session.id));
    try {
      await apiRetry(`/chat-sessions/${session.id}`, { method: 'DELETE' }, { attempts: 3 });
      setError('');
    } catch (cause) {
      setData(previous);
      setError(cause instanceof Error ? cause.message : '会话删除失败');
    }
  };
  const toggleFetchOnly = async (session: ChatSession) => {
    const next = !session.fetchOnly;
    const previous = data;
    setData((current) =>
      current.map((item) => (item.id === session.id ? { ...item, fetchOnly: next } : item)),
    );
    try {
      await apiRetry(
        `/chat-sessions/${session.id}`,
        { method: 'PATCH', json: { fetchOnly: next } },
        { attempts: 3 },
      );
      setError('');
    } catch (cause) {
      setData(previous);
      setError(cause instanceof Error ? cause.message : '只读状态保存失败');
    }
  };
  return (
    <div className="panel">
      <PanelTitle
        title="已配置聊天会话"
        subtitle="会话在绑定页面完成验证码验证后自动保存；只有已验证会话可用于蓝图"
        action={
          <button className="icon-button" onClick={() => void reload()}>
            <RefreshCw size={16} />
          </button>
        }
      />
      {error && <div className="panel-error">{error}</div>}
      {loading && <LoadingState text="正在读取聊天会话" />}
      <div className="list">
        {data.map((session) => (
          <div className="session-row" key={session.id}>
            <div className={`platform ${session.platform}`}>
              <MessagesSquare size={18} />
            </div>
            <div className="grow">
              <strong>{sessionLabel(session)}</strong>
              {session.fetchOnly && <em className="session-fetch-only">只读 · 机器人不发送</em>}
              {session.remark && <em className="session-remark">原名：{session.displayName}</em>}
              <span>
                {session.platform === 'discord'
                  ? `服务器 ${session.spaceId} · 频道 ${session.externalId}`
                  : `群号 ${session.externalId}`}
              </span>
            </div>
            {editingId === session.id ? (
              <div className="remark-editor">
                <input
                  autoFocus
                  value={remark}
                  placeholder="输入备注，留空可清除"
                  onChange={(event) => setRemark(event.target.value)}
                  onKeyDown={(event) => event.key === 'Enter' && void saveRemark(session)}
                />
                <button onClick={() => void saveRemark(session)}>保存</button>
                <button onClick={() => setEditingId('')}>取消</button>
              </div>
            ) : (
              <div className="session-actions">
                <button
                  className={session.fetchOnly ? 'fetch-only active' : 'fetch-only'}
                  title={
                    session.fetchOnly
                      ? '只读频道：机器人不会向此频道发送消息'
                      : '设为只读（机器人不向此频道发送消息）'
                  }
                  onClick={() => void toggleFetchOnly(session)}
                >
                  <ArrowRightLeft size={14} />
                </button>
                <button
                  title={session.remark ? '编辑备注' : '添加备注'}
                  onClick={() => {
                    setEditingId(session.id);
                    setRemark(session.remark ?? '');
                  }}
                >
                  <Pencil size={14} />
                </button>
                <button title="删除会话" onClick={() => void remove(session)}>
                  <Trash2 size={14} />
                </button>
              </div>
            )}
            <span className={`badge ${session.status === 'verified' ? 'success' : ''}`}>
              {session.status === 'verified' && <Check size={13} />}
              {session.status === 'verified'
                ? '已验证'
                : session.status === 'pending'
                  ? '等待验证码'
                  : session.status === 'stale'
                    ? '已失效'
                    : '已禁用'}
            </span>
          </div>
        ))}
        {!loading && !data.length && <Empty text="还没有聊天会话，请先到绑定会话完成验证" />}
      </div>
    </div>
  );
}

type FlowKind =
  | 'input'
  | 'output'
  | 'simulated-input'
  | 'simulated-output'
  | 'translation'
  | 'moderation'
  | 'review'
  | 'fixed'
  | 'renderer';
type FlowSimulationNote = {
  id: string;
  text: string;
  kind: 'done' | 'error';
};
type FlowData = {
  label: string;
  kind: FlowKind;
  sessionId?: string;
  includeSelf?: boolean;
  prompt?: string;
  memoryMode?: boolean;
  enableThinking?: boolean;
  threshold?: number;
  text?: string;
  outputText?: string;
  busy?: boolean;
  saveBusy?: boolean;
  simulationBusy?: boolean;
  hasUnpublishedChanges?: boolean;
  savePrompt?: boolean;
  onDraftChange?: () => void;
  onConfirmSaveSimulation?: () => void;
  onCancelSaveSimulation?: () => void;
  onSimulate?: (nodeId: string, text: string) => Promise<void>;
  simulation?:
    | {
        state: 'active' | 'done' | 'error';
        message?: string;
        activeMessageId?: string;
        progress?: number;
        /** Completed messages are kept as a small stack for coalesced runs. */
        messages?: FlowSimulationNote[];
        outputs?: string[];
      }
    | undefined;
};

const defaultTranslationPrompt =
  '请将消息自然、准确地翻译成目标聊天使用的语言。保留姓名、@提及、网址、代码、Emoji、换行和语气，不要回答、解释、审查或概括消息。';
const defaultModerationPrompt =
  '请评估文本的违规程度。正常对话应接近 0，明确严重违规应接近 1。重点考虑骚扰、仇恨、色情、暴力、自残、违法活动、隐私泄露和垃圾信息。';
const FLOW_ACTIVITY_POPUP_TTL_MS = 5_500;
const FLOW_ACTIVITY_COALESCE_MS = 80;
const FLOW_ACTIVITY_NOTE_LIMIT = 4;

function FlowNode({ id, data }: NodeProps<Node<FlowData>>) {
  const { deleteElements, updateNodeData } = useReactFlow();
  const [testText, setTestText] = useState('');
  const hasInput = data.kind !== 'input' && data.kind !== 'simulated-input';
  const hasOutput =
    data.kind !== 'output' &&
    data.kind !== 'simulated-output' &&
    data.kind !== 'moderation' &&
    data.kind !== 'review';
  const patchData = (patch: Partial<FlowData>) => {
    updateNodeData(id, patch);
    data.onDraftChange?.();
  };
  const progressStyle =
    data.simulation?.state === 'active'
      ? ({
          '--simulation-progress': `${Math.max(0, Math.min(100, data.simulation.progress ?? 0))}%`,
        } as CSSProperties)
      : undefined;
  return (
    <div className={`flow-node ${data.kind} ${data.simulation?.state ?? ''}`} style={progressStyle}>
      {data.savePrompt && (
        <div className="flow-save-prompt nodrag nopan" role="dialog">
          <strong>当前蓝图有未发布修改</strong>
          <span>先保存并发布，再运行这条模拟消息？</span>
          <div>
            <button
              disabled={Boolean(data.saveBusy || data.simulationBusy)}
              onClick={() => data.onConfirmSaveSimulation?.()}
            >
              {(data.saveBusy || data.simulationBusy) && (
                <LoaderCircle className="spin" size={13} />
              )}
              {data.saveBusy ? '保存中' : data.simulationBusy ? '运行中' : '保存并运行'}
            </button>
            <button
              disabled={Boolean(data.saveBusy || data.simulationBusy)}
              onClick={() => data.onCancelSaveSimulation?.()}
            >
              取消
            </button>
          </div>
        </div>
      )}
      {(data.simulation?.message || data.simulation?.messages?.length) && (
        <div className="flow-simulation-stack" role="status">
          {(data.simulation?.messages ?? []).map((message) => (
            <div className={`flow-simulation-note ${message.kind}`} key={message.id}>
              {message.text}
            </div>
          ))}
          {data.simulation.message &&
            data.simulation.activeMessageId !== data.simulation.messages?.at(-1)?.id && (
              <div className={`flow-simulation-note ${data.simulation.state}`}>
                {data.simulation.message}
              </div>
            )}
        </div>
      )}
      {hasInput && <Handle type="target" position={Position.Left} />}
      {hasOutput && <Handle type="source" position={Position.Right} />}
      {data.kind === 'moderation' && (
        <>
          <Handle id="passed" type="source" position={Position.Right} style={{ top: '38%' }} />
          <Handle id="blocked" type="source" position={Position.Right} style={{ top: '74%' }} />
          <span className="flow-handle-label passed">过审</span>
          <span className="flow-handle-label blocked">未过</span>
        </>
      )}
      {data.kind === 'review' && (
        <>
          <Handle id="passed" type="source" position={Position.Right} style={{ top: '42%' }} />
          <Handle id="blocked" type="source" position={Position.Right} style={{ top: '76%' }} />
          <span className="flow-handle-label passed">通过</span>
          <span className="flow-handle-label blocked">拦截</span>
        </>
      )}
      <span className="flow-node-kind">
        {data.kind === 'input'
          ? '消息入口'
          : data.kind === 'simulated-input'
            ? '模拟输入'
            : data.kind === 'output'
              ? '发送目标'
              : data.kind === 'simulated-output'
                ? '模拟输出'
                : data.kind === 'translation'
                  ? '文本翻译'
                  : data.kind === 'moderation'
                    ? '文本审核'
                    : data.kind === 'review'
                      ? '人工审核'
                      : data.kind === 'fixed'
                        ? '固定文本'
                        : '旧版图片合成'}
      </span>
      <strong>{data.label}</strong>
      {data.kind === 'simulated-input' && (
        <div className="flow-node-config simulated-io nodrag nopan">
          <textarea
            value={testText}
            onChange={(event) => setTestText(event.target.value)}
            placeholder="输入测试消息"
          />
          <button
            disabled={data.busy || !testText.trim()}
            onClick={() => void data.onSimulate?.(id, testText.trim())}
          >
            {data.busy ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />}
            {data.busy ? '运行中' : '发送'}
          </button>
        </div>
      )}
      {data.kind === 'simulated-output' &&
        ((data.simulation?.outputs?.length ?? 0) > 0 || data.outputText) && (
          <div className="simulated-output-values nodrag nopan">
            {(data.simulation?.outputs ?? [data.outputText])
              .filter(Boolean)
              .map((output, index) => (
                <div className="simulated-output-value" key={`${index}-${output}`}>
                  {output}
                </div>
              ))}
          </div>
        )}
      {data.kind === 'input' && (
        <div className="flow-node-config nodrag nopan">
          <label className="memory-toggle">
            <input
              type="checkbox"
              checked={Boolean(data.includeSelf)}
              onChange={(event) => patchData({ includeSelf: event.target.checked })}
            />
            <span>包括自身</span>
          </label>
        </div>
      )}
      {data.kind === 'translation' && (
        <div className="flow-node-config nodrag nopan">
          <textarea
            value={data.prompt ?? ''}
            onChange={(event) => patchData({ prompt: event.target.value })}
            placeholder="翻译提示词"
          />
          <div className="flow-node-toggle-row">
            <label className="memory-toggle">
              <input
                type="checkbox"
                checked={Boolean(data.memoryMode)}
                onChange={(event) => patchData({ memoryMode: event.target.checked })}
              />
              <span>记忆模式</span>
            </label>
            <label className="memory-toggle">
              <input
                type="checkbox"
                checked={Boolean(data.enableThinking)}
                onChange={(event) => patchData({ enableThinking: event.target.checked })}
              />
              <span>开启思考</span>
            </label>
          </div>
        </div>
      )}
      {data.kind === 'moderation' && (
        <div className="flow-node-config nodrag nopan">
          <label>
            允许的最高违规分数：{Math.round((data.threshold ?? 0.5) * 100)}%
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={data.threshold ?? 0.5}
              onChange={(event) => patchData({ threshold: Number(event.target.value) })}
            />
          </label>
          <textarea
            value={data.prompt ?? ''}
            onChange={(event) => patchData({ prompt: event.target.value })}
            placeholder="审核提示词"
          />
          <label className="memory-toggle">
            <input
              type="checkbox"
              checked={Boolean(data.enableThinking)}
              onChange={(event) => patchData({ enableThinking: event.target.checked })}
            />
            <span>开启思考</span>
          </label>
        </div>
      )}
      {data.kind === 'fixed' && (
        <div className="flow-node-config nodrag nopan">
          <textarea
            value={data.text ?? ''}
            onChange={(event) => patchData({ text: event.target.value })}
            placeholder="经过此模块后输出的固定文本"
          />
        </div>
      )}
      <button
        className="flow-node-delete nodrag nopan"
        title="删除节点"
        aria-label={`删除${data.label}`}
        onClick={() => {
          data.onDraftChange?.();
          void deleteElements({ nodes: [{ id }] });
        }}
      >
        <Trash2 size={13} />
      </button>
    </div>
  );
}

type MobileBlueprintFlowProps = {
  nodes: Node<FlowData>[];
  edges: Edge[];
};

function MobileBlueprintFlow({ nodes, edges }: MobileBlueprintFlowProps) {
  const [rootId, setRootId] = useState('');
  const [choices, setChoices] = useState<Record<string, string>>({});
  const incoming = useMemo(() => {
    const map = new Set(edges.map((edge) => edge.target));
    return nodes.filter((node) => !map.has(node.id));
  }, [edges, nodes]);
  const outgoing = useMemo(() => {
    const map = new Map<string, Edge[]>();
    for (const edge of edges) {
      const list = map.get(edge.source) ?? [];
      list.push(edge);
      map.set(edge.source, list);
    }
    return map;
  }, [edges]);

  useEffect(() => {
    if (!rootId || !nodes.some((node) => node.id === rootId)) {
      setRootId(incoming[0]?.id ?? nodes[0]?.id ?? '');
    }
  }, [incoming, nodes, rootId]);

  const pathView = useMemo(() => {
    const pathNodes: Node<FlowData>[] = [];
    const pathEdges: Edge[] = [];
    const visited = new Set<string>();
    let currentId = rootId;
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const node = nodes.find((item) => item.id === currentId);
      if (!node) break;
      pathNodes.push(node);
      const next = outgoing.get(currentId) ?? [];
      if (!next.length) break;
      const chosen = choices[currentId];
      const selected = next.find((edge) => edge.id === chosen) ?? next[0];
      if (!selected) break;
      pathEdges.push(selected);
      currentId = selected.target;
    }
    return { nodes: pathNodes, edges: pathEdges };
  }, [choices, nodes, outgoing, rootId]);
  const orderedPath = pathView.nodes;
  const pathIds = new Set(orderedPath.map((node) => node.id));
  const connectedIds = new Set(edges.flatMap((edge) => [edge.source, edge.target]));
  const disconnected = nodes.filter((node) => !pathIds.has(node.id) && !connectedIds.has(node.id));

  if (!nodes.length) {
    return (
      <div className="mobile-blueprint-flow empty">
        <span>添加模块后，这里会显示纵向流程。</span>
      </div>
    );
  }

  return (
    <div className="mobile-blueprint-flow">
      <div className="mobile-readonly-notice" role="note">
        <strong>手机端仅供查看</strong>
        <span>请使用桌面端编辑模块、调整连线、发布蓝图或运行模拟消息。</span>
      </div>
      <div className="mobile-flow-heading">
        <div>
          <strong>流程预览</strong>
          <span>点击分支按钮可以查看不同出口的后续路径。</span>
        </div>
        {incoming.length > 1 && (
          <label>
            起始入口
            <select value={rootId} onChange={(event) => setRootId(event.target.value)}>
              {incoming.map((node) => (
                <option key={node.id} value={node.id}>
                  {node.data.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="mobile-flow-path">
        {orderedPath.map((node, index) => {
          const branches = outgoing.get(node.id) ?? [];
          return (
            <div className="mobile-flow-step" key={node.id}>
              <MobileFlowCard node={node} allNodes={nodes} outgoing={branches} />
              {branches.length > 1 && (
                <div className="mobile-branch-picker">
                  <span>选择下一条路径</span>
                  <div>
                    {branches.map((edge, branchIndex) => (
                      <button
                        className={choices[node.id] === edge.id ? 'active' : ''}
                        key={edge.id}
                        onClick={() =>
                          setChoices((current) => ({ ...current, [node.id]: edge.id }))
                        }
                      >
                        {mobileBranchLabel(edge, branchIndex)}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {index < orderedPath.length - 1 && branches.length <= 1 && (
                <div className="mobile-flow-connector" aria-hidden="true">
                  ↓
                </div>
              )}
            </div>
          );
        })}
      </div>
      {disconnected.length > 0 && (
        <details className="mobile-disconnected">
          <summary>未连接模块（{disconnected.length}）</summary>
          {disconnected.map((node) => (
            <MobileFlowCard
              key={node.id}
              node={node}
              allNodes={nodes}
              outgoing={outgoing.get(node.id) ?? []}
            />
          ))}
        </details>
      )}
    </div>
  );
}

function MobileFlowCard({
  node,
  allNodes,
  outgoing,
}: {
  node: Node<FlowData>;
  allNodes: Node<FlowData>[];
  outgoing: Edge[];
}) {
  const { data } = node;
  const cardStyle = {
    '--simulation-progress': `${Math.max(0, Math.min(100, data.simulation?.state === 'active' ? (data.simulation.progress ?? 0) : 0))}%`,
  } as CSSProperties;
  return (
    <article
      className={`mobile-flow-card ${data.kind} ${data.simulation?.state ?? ''}`}
      style={cardStyle}
    >
      <div className="mobile-flow-card-head">
        <span className="mobile-flow-kind">{flowKindLabel(data.kind)}</span>
      </div>
      <strong>{data.label}</strong>
      {(data.simulation?.message || data.simulation?.messages?.length) && (
        <div className="mobile-flow-activity-stack">
          {(data.simulation?.messages ?? []).map((message) => (
            <div className="mobile-flow-activity" key={message.id}>
              <p>{message.text}</p>
            </div>
          ))}
          {data.simulation.message &&
            data.simulation.activeMessageId !== data.simulation.messages?.at(-1)?.id && (
              <div className="mobile-flow-activity">
                <p>{data.simulation.message}</p>
              </div>
            )}
        </div>
      )}
      {data.kind === 'simulated-input' && <div className="mobile-flow-output">模拟输入</div>}
      {data.kind === 'simulated-output' &&
        ((data.simulation?.outputs?.length ?? 0) > 0 || data.outputText) && (
          <div className="mobile-flow-output-stack">
            {(data.simulation?.outputs ?? [data.outputText])
              .filter(Boolean)
              .map((output, index) => (
                <div className="mobile-flow-output" key={`${index}-${output}`}>
                  {output}
                </div>
              ))}
          </div>
        )}
      {data.kind === 'translation' && (
        <div className="mobile-flow-readonly-config">
          <span>
            {data.memoryMode ? '已开启记忆模式' : '未开启记忆模式'}
            {' · '}
            {data.enableThinking ? '已开启思考' : '未开启思考'}
          </span>
          <p>{data.prompt || '未设置翻译提示词'}</p>
        </div>
      )}
      {data.kind === 'moderation' && (
        <div className="mobile-flow-readonly-config">
          <span>
            允许的最高违规分数：{Math.round((data.threshold ?? 0.5) * 100)}%{' · '}
            {data.enableThinking ? '已开启思考' : '未开启思考'}
          </span>
          <p>{data.prompt || '未设置审核提示词'}</p>
        </div>
      )}
      {data.kind === 'fixed' && (
        <div className="mobile-flow-output">{data.text || '输出空文本'}</div>
      )}
      {data.kind !== 'output' && data.kind !== 'simulated-output' && (
        <div className="mobile-flow-connections readonly">
          <span>当前连接</span>
          {(data.kind === 'moderation' || data.kind === 'review'
            ? [
                { handle: 'passed', label: data.kind === 'review' ? '通过' : '过审' },
                { handle: 'blocked', label: data.kind === 'review' ? '拦截' : '未过' },
              ]
            : [{ handle: undefined, label: '下一步' }]
          ).map(({ handle, label }) => {
            const edge = outgoing.find((item) => item.sourceHandle === handle);
            const target = allNodes.find((candidate) => candidate.id === edge?.target);
            return (
              <div key={handle ?? 'default'}>
                <span>{label}</span>
                <strong>{target?.data.label ?? '未连接'}</strong>
              </div>
            );
          })}
        </div>
      )}
    </article>
  );
}

function flowKindLabel(kind: FlowKind): string {
  return kind === 'input'
    ? '消息入口'
    : kind === 'simulated-input'
      ? '模拟输入'
      : kind === 'output'
        ? '发送目标'
        : kind === 'simulated-output'
          ? '模拟输出'
          : kind === 'translation'
            ? '文本翻译'
            : kind === 'moderation'
              ? '文本审核'
              : kind === 'review'
                ? '人工审核'
                : kind === 'fixed'
                  ? '固定文本'
                  : '图片合成';
}

function mobileBranchLabel(edge: Edge, index: number): string {
  if (edge.sourceHandle === 'passed') return '通过 / 过审';
  if (edge.sourceHandle === 'blocked') return '拦截 / 未过';
  return `分支 ${index + 1}`;
}

function defaultFlowSourceHandle(node: Node<FlowData> | undefined): string | undefined {
  return node?.data.kind === 'moderation' || node?.data.kind === 'review' ? 'passed' : undefined;
}

function BlueprintEditor() {
  const sessions = useLoad<ChatSession[]>('/chat-sessions', []);
  const blueprints = useLoad<Blueprint[]>('/blueprints', []);
  const simulationSettings = useLoad<{ delayMs: number }>('/settings/simulation', {
    delayMs: 1_000,
  });
  const usable = sessions.data.filter((item) => item.status === 'verified');
  const [nodes, setNodes, onNodesChangeBase] = useNodesState<Node<FlowData>>([]);
  const [edges, setEdges, onEdgesChangeBase] = useEdgesState<Edge>([]);
  const [name, setName] = useState('双向翻译');
  const [selected, setSelected] = useState('');
  const [currentBlueprintId, setCurrentBlueprintId] = useState('');
  const [loadedVersion, setLoadedVersion] = useState<number>();
  const [draftDirty, setDraftDirty] = useState(false);
  const [pendingSimulation, setPendingSimulation] = useState<
    { nodeId: string; text: string } | undefined
  >();
  const [saving, setSaving] = useState(false);
  const [simulationBusy, setSimulationBusy] = useState(false);
  const [blueprintAction, setBlueprintAction] = useState<
    { id: string; kind: 'toggle' | 'delete' } | undefined
  >();
  const [editorKey, setEditorKey] = useState(0);
  const [notice, setNotice] = useState('');
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<Node<FlowData>, Edge>>();
  const activityCursor = useRef('');
  const activityQueue = useRef<BlueprintActivity[]>([]);
  const activityPlaying = useRef(false);
  const nodeTypes = useMemo(() => ({ session: FlowNode }), []);

  const onNodesChange = (changes: Parameters<typeof onNodesChangeBase>[0]) => {
    if (
      changes.some(
        (change) =>
          ['add', 'remove', 'replace'].includes(change.type) ||
          (change.type === 'position' && change.dragging !== undefined),
      )
    )
      setDraftDirty(true);
    onNodesChangeBase(changes);
  };
  const onEdgesChange = (changes: Parameters<typeof onEdgesChangeBase>[0]) => {
    if (changes.some((change) => ['add', 'remove', 'replace'].includes(change.type)))
      setDraftDirty(true);
    onEdgesChangeBase(changes);
  };

  useEffect(() => {
    if (!flowInstance || !nodes.length) return;
    const frame = window.requestAnimationFrame(() => {
      void flowInstance.fitView({ padding: 0.18, duration: 220, maxZoom: 1 });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [flowInstance, nodes.length]);

  useEffect(() => {
    if (!currentBlueprintId) return;
    let cancelled = false;
    let initialized = false;
    const controller = new AbortController();
    activityCursor.current = '';
    activityQueue.current = [];
    activityPlaying.current = false;

    const progressFrames = new Set<number>();
    const noteTimers = new Set<number>();
    const sleep = (milliseconds: number) =>
      new Promise<void>((resolve) => window.setTimeout(resolve, Math.max(0, milliseconds)));

    const waitWithProgress = (
      nodeIds: readonly string[],
      startProgress: number,
      endProgress: number,
      delayMs: number,
      easing: 'linear' | 'ease-out' = 'linear',
    ) =>
      new Promise<void>((resolve) => {
        const targets = new Set(nodeIds);
        const duration = Math.max(0, delayMs);
        const startedAt = performance.now();
        let frame: number | undefined;
        const update = () => {
          if (frame !== undefined) progressFrames.delete(frame);
          const elapsed =
            duration === 0 ? 1 : Math.min(1, (performance.now() - startedAt) / duration);
          const eased = easing === 'ease-out' ? 1 - Math.pow(1 - elapsed, 3) : elapsed;
          const progress = Math.min(
            endProgress,
            startProgress + eased * (endProgress - startProgress),
          );
          if (!cancelled) {
            setNodes((current) =>
              current.map((node) =>
                targets.has(node.id) && node.data.simulation?.state === 'active'
                  ? {
                      ...node,
                      data: {
                        ...node.data,
                        simulation: {
                          ...node.data.simulation,
                          progress: Math.max(node.data.simulation.progress ?? 0, progress),
                        },
                      },
                    }
                  : node,
              ),
            );
          }
          if (elapsed >= 1 || cancelled) {
            resolve();
          } else {
            frame = window.requestAnimationFrame(update);
            progressFrames.add(frame);
          }
        };
        update();
      });

    let driftTimer: number | undefined;
    const scheduleProgressDrift = () => {
      driftTimer = window.setTimeout(
        () => {
          if (cancelled) return;
          setNodes((current) =>
            current.map((node) => {
              if (node.data.simulation?.state !== 'active') return node;
              const progress = Math.max(50, node.data.simulation.progress ?? 50);
              if (progress < 90) return node;
              if (progress >= 99) return node;
              const remaining = 99 - progress;
              const step = Math.max(0.08, remaining * (0.035 + Math.random() * 0.075));
              return {
                ...node,
                data: {
                  ...node.data,
                  simulation: {
                    ...node.data.simulation,
                    progress: Math.min(99, progress + step),
                  },
                },
              };
            }),
          );
          scheduleProgressDrift();
        },
        500 + Math.random() * 1_500,
      );
    };
    scheduleProgressDrift();

    const scheduleNoteDismiss = (nodeId: string, noteId: string): void => {
      let timer = 0;
      timer = window.setTimeout(() => {
        noteTimers.delete(timer);
        if (cancelled) return;
        setNodes((current) =>
          current.map((node) => {
            if (node.id !== nodeId || !node.data.simulation) return node;
            const simulation = node.data.simulation;
            const messages = (simulation.messages ?? []).filter((note) => note.id !== noteId);
            const nextSimulation = { ...simulation, messages };
            if (simulation.activeMessageId === noteId) {
              delete nextSimulation.message;
              delete nextSimulation.activeMessageId;
            }
            return {
              ...node,
              data: {
                ...node.data,
                simulation: nextSimulation,
              },
            };
          }),
        );
      }, FLOW_ACTIVITY_POPUP_TTL_MS);
      noteTimers.add(timer);
    };

    const activityBatchKey = (activity: BlueprintActivity): string =>
      activity.batchId ?? activity.traceId ?? 'unknown';
    const activityGroupKey = (activity: BlueprintActivity): string =>
      `${activity.blueprintId}:${activity.version}:${activityBatchKey(activity)}:${activity.step}:${activity.phase ?? 'completed'}`;
    const takeActivityGroup = async (): Promise<BlueprintActivity[] | undefined> => {
      const first = activityQueue.current.shift();
      if (!first) return undefined;
      await sleep(FLOW_ACTIVITY_COALESCE_MS);
      if (cancelled) return undefined;
      const key = activityGroupKey(first);
      const group = [first];
      const remaining: BlueprintActivity[] = [];
      for (const activity of activityQueue.current) {
        if (activityGroupKey(activity) === key) group.push(activity);
        else remaining.push(activity);
      }
      activityQueue.current = remaining;
      return group.sort((left, right) => left.sequence - right.sequence);
    };

    const playBatches = async (): Promise<void> => {
      if (activityPlaying.current) return;
      activityPlaying.current = true;
      try {
        while (!cancelled && activityQueue.current.length) {
          const group = await takeActivityGroup();
          if (!group?.length) break;
          const delay = Math.max(0, simulationSettings.data.delayMs ?? 1_000);
          const entered = group.filter((activity) => (activity.phase ?? 'completed') === 'entered');
          const failed = group.filter((activity) => activity.phase === 'failed');
          const completed = group.filter(
            (activity) => (activity.phase ?? 'completed') === 'completed',
          );

          const enteredNodeIds = [...new Set(entered.map((activity) => activity.nodeId))];
          if (enteredNodeIds.length) {
            setNodes((current) =>
              current.map((node) =>
                enteredNodeIds.includes(node.id)
                  ? {
                      ...node,
                      data: {
                        ...node.data,
                        simulation: {
                          state: 'active' as const,
                          progress: 50,
                          messages: node.data.simulation?.messages ?? [],
                          outputs: node.data.simulation?.outputs ?? [],
                        },
                      },
                    }
                  : node,
              ),
            );
            await waitWithProgress(enteredNodeIds, 50, 90, delay, 'ease-out');
          }

          if (failed.length) {
            setNodes((current) =>
              current.map((node) => {
                const activity = failed.find((item) => item.nodeId === node.id);
                if (!activity) return node;
                const note: FlowSimulationNote = {
                  id: activity.id,
                  text: activity.message,
                  kind: 'error',
                };
                const messages = [...(node.data.simulation?.messages ?? []), note].slice(
                  -FLOW_ACTIVITY_NOTE_LIMIT,
                );
                return {
                  ...node,
                  data: {
                    ...node.data,
                    simulation: {
                      state: 'error' as const,
                      message: activity.message,
                      activeMessageId: activity.id,
                      progress: 100,
                      messages,
                      outputs: node.data.simulation?.outputs ?? [],
                    },
                  },
                };
              }),
            );
            for (const activity of failed) scheduleNoteDismiss(activity.nodeId, activity.id);
          }

          if (completed.length) {
            const completedByNode = new Map<string, BlueprintActivity[]>();
            for (const activity of completed) {
              const list = completedByNode.get(activity.nodeId) ?? [];
              list.push(activity);
              completedByNode.set(activity.nodeId, list);
              scheduleNoteDismiss(activity.nodeId, activity.id);
            }
            setNodes((current) =>
              current.map((node) => {
                const activities = completedByNode.get(node.id);
                if (!activities?.length) return node;
                const last = activities.at(-1)!;
                const notes = activities.map<FlowSimulationNote>((activity) => ({
                  id: activity.id,
                  text: activity.message,
                  kind: 'done',
                }));
                const messages = [...(node.data.simulation?.messages ?? []), ...notes].slice(
                  -FLOW_ACTIVITY_NOTE_LIMIT,
                );
                const output = activities.find(
                  (activity) => activity.nodeType === 'simulated-output' && activity.text,
                );
                const outputs = output
                  ? [...(node.data.simulation?.outputs ?? []), output.text!].slice(-8)
                  : (node.data.simulation?.outputs ?? []);
                return {
                  ...node,
                  data: {
                    ...node.data,
                    ...(output ? { outputText: output.text } : {}),
                    simulation: {
                      state: 'active' as const,
                      message: last.message,
                      activeMessageId: last.id,
                      messages,
                      outputs,
                      progress: Math.max(90, node.data.simulation?.progress ?? 0),
                    },
                  },
                };
              }),
            );

            const completedNodeIds = [...completedByNode.keys()];
            await waitWithProgress(
              completedNodeIds,
              90,
              99,
              Math.min(260, Math.max(120, Math.round(delay * 0.35))),
              'ease-out',
            );
            const nextNodeIds = new Set<string>();
            const finishedNodeIds = new Set<string>();
            for (const activity of completed) {
              const targets =
                activity.nodeType === 'chat-output' || activity.nodeType === 'simulated-output'
                  ? []
                  : edges
                      .filter(
                        (edge) =>
                          edge.source === activity.nodeId &&
                          (!activity.route || (edge.sourceHandle ?? undefined) === activity.route),
                      )
                      .map((edge) => edge.target);
              finishedNodeIds.add(activity.nodeId);
              targets.forEach((target) => nextNodeIds.add(target));
            }
            setNodes((current) =>
              current.map((node) => {
                if (nextNodeIds.has(node.id)) {
                  return {
                    ...node,
                    data: {
                      ...node.data,
                      simulation: {
                        state: 'active' as const,
                        progress: 50,
                        messages: node.data.simulation?.messages ?? [],
                        outputs: node.data.simulation?.outputs ?? [],
                      },
                    },
                  };
                }
                if (!finishedNodeIds.has(node.id)) return node;
                const previousSimulation = node.data.simulation;
                return {
                  ...node,
                  data: {
                    ...node.data,
                    simulation: {
                      state: 'done' as const,
                      progress: 100,
                      messages: previousSimulation?.messages ?? [],
                      outputs: previousSimulation?.outputs ?? [],
                      ...(previousSimulation?.message !== undefined
                        ? { message: previousSimulation.message }
                        : {}),
                      ...(previousSimulation?.activeMessageId !== undefined
                        ? { activeMessageId: previousSimulation.activeMessageId }
                        : {}),
                    },
                  },
                };
              }),
            );
          }
        }
      } finally {
        activityPlaying.current = false;
        if (!cancelled && activityQueue.current.length) void playBatches();
      }
    };

    const poll = async () => {
      while (!cancelled) {
        try {
          const page = await api<BlueprintActivityPage>(
            `/blueprints/${currentBlueprintId}/activity?cursor=${encodeURIComponent(activityCursor.current)}&waitMs=${initialized ? 25_000 : 0}`,
            { signal: controller.signal, retry: { attempts: 1 } },
          );
          if (cancelled) return;
          activityCursor.current = page.cursor;
          if (!initialized) {
            initialized = true;
            const latestOutputs = new Map<string, string>();
            for (const activity of page.items) {
              if (activity.nodeType === 'simulated-output' && activity.phase !== 'entered') {
                latestOutputs.set(activity.nodeId, activity.text ?? '');
              }
            }
            if (latestOutputs.size) {
              setNodes((current) =>
                current.map((node) =>
                  latestOutputs.has(node.id)
                    ? {
                        ...node,
                        data: { ...node.data, outputText: latestOutputs.get(node.id) ?? '' },
                      }
                    : node,
                ),
              );
            }
            continue;
          }
          if (page.items.length) {
            activityQueue.current.push(...page.items);
            activityQueue.current.sort((left, right) => left.sequence - right.sequence);
            void playBatches();
          }
        } catch (cause) {
          if (cancelled || (cause instanceof DOMException && cause.name === 'AbortError')) return;
          await new Promise((resolve) => window.setTimeout(resolve, 1_500));
        }
      }
    };
    void poll();
    return () => {
      cancelled = true;
      controller.abort();
      activityQueue.current = [];
      activityPlaying.current = false;
      if (driftTimer !== undefined) window.clearTimeout(driftTimer);
      for (const frame of progressFrames) window.cancelAnimationFrame(frame);
      progressFrames.clear();
      for (const timer of noteTimers) window.clearTimeout(timer);
      noteTimers.clear();
    };
  }, [currentBlueprintId, edges, setNodes, simulationSettings.data.delayMs]);

  if (sessions.loading || blueprints.loading) {
    return <LoadingState text="正在载入蓝图和会话" />;
  }

  const resetEditor = () => {
    setCurrentBlueprintId('');
    setLoadedVersion(undefined);
    setName('双向翻译');
    setNodes([]);
    setEdges([]);
    setDraftDirty(false);
    setPendingSimulation(undefined);
    setNotice('正在创建新蓝图。');
    setEditorKey((value) => value + 1);
  };

  const openBlueprint = (blueprint: Blueprint) => {
    const version =
      blueprint.versions.find((item) => item.version === blueprint.activeVersion) ??
      blueprint.versions.find((item) => item.status === 'published') ??
      blueprint.versions[0];
    if (!version) {
      setNotice('该蓝图没有可载入的版本。');
      return;
    }
    const flowNodes = version.nodes
      .filter((node) =>
        [
          'chat-input',
          'chat-output',
          'simulated-input',
          'simulated-output',
          'llm-translation',
          'llm-moderation',
          'manual-review',
          'fixed-text',
          'card-renderer',
        ].includes(node.type),
      )
      .map((node) => {
        const sessionId = typeof node.config.sessionId === 'string' ? node.config.sessionId : '';
        const session = sessions.data.find((item) => item.id === sessionId);
        const kind: FlowKind =
          node.type === 'chat-input'
            ? 'input'
            : node.type === 'simulated-input'
              ? 'simulated-input'
              : node.type === 'chat-output'
                ? 'output'
                : node.type === 'simulated-output'
                  ? 'simulated-output'
                  : node.type === 'llm-translation'
                    ? 'translation'
                    : node.type === 'llm-moderation'
                      ? 'moderation'
                      : node.type === 'manual-review'
                        ? 'review'
                        : node.type === 'fixed-text'
                          ? 'fixed'
                          : 'renderer';
        return {
          id: node.id,
          type: 'session',
          position: node.position,
          data: {
            label:
              kind === 'input' || kind === 'output'
                ? session
                  ? sessionLabel(session)
                  : sessionId
                : kind === 'simulated-input'
                  ? '手动发送测试消息'
                  : kind === 'simulated-output'
                    ? '查看流程输出'
                    : kind === 'translation'
                      ? '翻译当前文本'
                      : kind === 'moderation'
                        ? '按违规分数分流'
                        : kind === 'review'
                          ? '等待管理员处理'
                          : kind === 'fixed'
                            ? '替换当前文本'
                            : '使用原消息资料生成 PNG',
            kind,
            ...(sessionId ? { sessionId } : {}),
            ...(typeof node.config.includeSelf === 'boolean'
              ? { includeSelf: node.config.includeSelf }
              : {}),
            ...(typeof node.config.prompt === 'string' ? { prompt: node.config.prompt } : {}),
            ...(typeof node.config.memoryMode === 'boolean'
              ? { memoryMode: node.config.memoryMode }
              : {}),
            ...(typeof node.config.enableThinking === 'boolean'
              ? { enableThinking: node.config.enableThinking }
              : {}),
            ...(typeof node.config.threshold === 'number'
              ? { threshold: node.config.threshold }
              : {}),
            ...(typeof node.config.text === 'string' ? { text: node.config.text } : {}),
          },
        };
      });
    setCurrentBlueprintId(blueprint.id);
    setLoadedVersion(version.version);
    setName(blueprint.name);
    setNodes(flowNodes);
    setEdges(
      version.edges.map((edge) => ({
        id: edge.id,
        source: edge.sourceNodeId,
        target: edge.targetNodeId,
        ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}),
        ...(edge.targetHandle ? { targetHandle: edge.targetHandle } : {}),
      })),
    );
    setDraftDirty(false);
    setPendingSimulation(undefined);
    setNotice(`已载入 ${blueprint.name} · v${version.version}`);
    setEditorKey((value) => value + 1);
  };

  const addNode = (kind: FlowKind) => {
    const session = usable.find((item) => item.id === selected);
    const pseudoKind =
      selected === '__simulated-input__'
        ? 'simulated-input'
        : selected === '__simulated-output__'
          ? 'simulated-output'
          : undefined;
    if (kind === 'input' && pseudoKind === 'simulated-output') {
      setNotice('“模拟输出”请使用“发送目标”按钮添加。');
      return;
    }
    if (kind === 'output' && pseudoKind === 'simulated-input') {
      setNotice('“模拟输入”请使用“消息入口”按钮添加。');
      return;
    }
    const resolvedKind =
      kind === 'input' && pseudoKind === 'simulated-input'
        ? 'simulated-input'
        : kind === 'output' && pseudoKind === 'simulated-output'
          ? 'simulated-output'
          : kind;
    if ((resolvedKind === 'input' || resolvedKind === 'output') && !session) {
      setNotice('添加消息入口或发送目标前，请先选择一个已验证会话。');
      return;
    }
    const moduleDefaults: Record<
      Exclude<FlowKind, 'input' | 'output' | 'simulated-input' | 'simulated-output'>,
      FlowData
    > = {
      translation: {
        kind: 'translation',
        label: '翻译当前文本',
        prompt: defaultTranslationPrompt,
        memoryMode: false,
        enableThinking: false,
      },
      moderation: {
        kind: 'moderation',
        label: '按违规分数分流',
        prompt: defaultModerationPrompt,
        threshold: 0.5,
        enableThinking: false,
      },
      review: { kind: 'review', label: '等待管理员处理' },
      fixed: { kind: 'fixed', label: '替换当前文本', text: '内容未通过审核' },
      renderer: { kind: 'renderer', label: '使用原消息资料生成 PNG' },
    };
    const data: FlowData =
      resolvedKind === 'input' || resolvedKind === 'output'
        ? {
            kind: resolvedKind,
            label: sessionLabel(session!),
            sessionId: session!.id,
          }
        : resolvedKind === 'simulated-input'
          ? { kind: 'simulated-input', label: '手动发送测试消息' }
          : resolvedKind === 'simulated-output'
            ? { kind: 'simulated-output', label: '查看流程输出' }
            : moduleDefaults[resolvedKind];
    const column =
      resolvedKind === 'input' || resolvedKind === 'simulated-input'
        ? 'input'
        : resolvedKind === 'output' || resolvedKind === 'simulated-output'
          ? 'output'
          : 'processor';
    const columnCount = nodes.filter((node) => {
      const nodeColumn =
        node.data.kind === 'input' || node.data.kind === 'simulated-input'
          ? 'input'
          : node.data.kind === 'output' || node.data.kind === 'simulated-output'
            ? 'output'
            : 'processor';
      return nodeColumn === column;
    }).length;
    const incomingIds = new Set(edges.map((edge) => edge.target));
    const starts = nodes
      .filter((node) => !incomingIds.has(node.id))
      .sort((left, right) => {
        const leftInput = left.data.kind === 'input' || left.data.kind === 'simulated-input';
        const rightInput = right.data.kind === 'input' || right.data.kind === 'simulated-input';
        return Number(rightInput) - Number(leftInput) || left.position.y - right.position.y;
      });
    let terminal = starts[0] ?? nodes[0];
    const visited = new Set<string>();
    while (terminal && !visited.has(terminal.id)) {
      visited.add(terminal.id);
      const nextEdge = edges.find((edge) => edge.source === terminal!.id);
      const nextNode = nextEdge ? nodes.find((node) => node.id === nextEdge.target) : undefined;
      if (!nextNode) break;
      terminal = nextNode;
    }
    const nodeId = createBrowserId();
    const node: Node<FlowData> = {
      id: nodeId,
      type: 'session',
      position: terminal
        ? { x: terminal.position.x + 280, y: terminal.position.y }
        : {
            x: column === 'input' ? 60 : column === 'output' ? 920 : 360,
            y: 70 + columnCount * (column === 'processor' ? 230 : 165),
          },
      data,
    };
    setNodes((current) => [...current, node]);
    // Auto-connect only extends a forward flow. Never link a terminal
    // (output-type) node and never target an entry (input-type) node:
    // doing so mid-chain would wire e.g. chat-output → chat-input and the
    // saved blueprint would fail validation with a CYCLE.
    const terminalIsOutput =
      terminal?.data.kind === 'output' || terminal?.data.kind === 'simulated-output';
    const nodeIsInput = resolvedKind === 'input' || resolvedKind === 'simulated-input';
    if (terminal && !terminalIsOutput && !nodeIsInput) {
      const sourceHandle = defaultFlowSourceHandle(terminal);
      setEdges((current) => [
        ...current,
        {
          id: createBrowserId(),
          source: terminal.id,
          target: nodeId,
          ...(sourceHandle ? { sourceHandle } : {}),
        },
      ]);
      setNotice(`已添加“${data.label}”并连接到流程末尾。`);
    } else if (terminal) {
      setNotice(`已添加“${data.label}”。`);
    }
    setDraftDirty(true);
  };
  const buildGraph = () => ({
    nodes: nodes.map((node) => ({
      id: node.id,
      type:
        node.data.kind === 'input'
          ? 'chat-input'
          : node.data.kind === 'simulated-input'
            ? 'simulated-input'
            : node.data.kind === 'output'
              ? 'chat-output'
              : node.data.kind === 'simulated-output'
                ? 'simulated-output'
                : node.data.kind === 'translation'
                  ? 'llm-translation'
                  : node.data.kind === 'moderation'
                    ? 'llm-moderation'
                    : node.data.kind === 'review'
                      ? 'manual-review'
                      : node.data.kind === 'fixed'
                        ? 'fixed-text'
                        : 'card-renderer',
      position: node.position,
      config:
        node.data.kind === 'input'
          ? { sessionId: node.data.sessionId, includeSelf: Boolean(node.data.includeSelf) }
          : node.data.kind === 'output'
            ? { sessionId: node.data.sessionId }
            : node.data.kind === 'translation'
              ? {
                  prompt: node.data.prompt,
                  memoryMode: Boolean(node.data.memoryMode),
                  enableThinking: Boolean(node.data.enableThinking),
                }
              : node.data.kind === 'moderation'
                ? {
                    prompt: node.data.prompt,
                    threshold: node.data.threshold ?? 0.5,
                    enableThinking: Boolean(node.data.enableThinking),
                  }
                : node.data.kind === 'fixed'
                  ? { text: node.data.text ?? '' }
                  : {},
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      sourceNodeId: edge.source,
      targetNodeId: edge.target,
      ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}),
      ...(edge.targetHandle ? { targetHandle: edge.targetHandle } : {}),
    })),
  });

  const executeSimulatedInput = async (nodeId: string, text: string) => {
    if (!currentBlueprintId || loadedVersion === undefined) {
      setNotice('请先保存并发布蓝图，再从模拟输入节点发送消息。');
      return;
    }
    setNodes((current) =>
      current.map((node) =>
        node.id === nodeId
          ? {
              ...node,
              data: {
                ...node.data,
                busy: true,
                simulation: {
                  state: 'active' as const,
                  progress: 50,
                },
              },
            }
          : node,
      ),
    );
    setSimulationBusy(true);
    try {
      await api(`/blueprints/${currentBlueprintId}/simulated-input/${nodeId}`, {
        method: 'POST',
        json: { text },
      });
      setNotice('模拟消息已运行；若流程连接到真实发送目标，消息也已实际发送。');
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : '模拟消息运行失败');
      setNodes((current) =>
        current.map((node) =>
          node.id === nodeId
            ? {
                ...node,
                data: {
                  ...node.data,
                  simulation: {
                    state: 'error' as const,
                    message: cause instanceof Error ? cause.message : '模拟消息运行失败',
                    progress: 100,
                  },
                },
              }
            : node,
        ),
      );
    } finally {
      setSimulationBusy(false);
      setNodes((current) =>
        current.map((node) =>
          node.id === nodeId ? { ...node, data: { ...node.data, busy: false } } : node,
        ),
      );
    }
  };

  const runSimulatedInput = async (nodeId: string, text: string) => {
    if (draftDirty) {
      setPendingSimulation({ nodeId, text });
      return;
    }
    await executeSimulatedInput(nodeId, text);
  };

  const save = async (): Promise<boolean> => {
    if (saving) return false;
    setSaving(true);
    try {
      const graph = buildGraph();
      let version: Pick<BlueprintVersion, 'blueprintId' | 'version'>;
      if (currentBlueprintId) {
        await api(`/blueprints/${currentBlueprintId}`, {
          method: 'PATCH',
          json: { name },
        });
        version = await api<BlueprintVersion>(`/blueprints/${currentBlueprintId}/versions`, {
          method: 'POST',
          json: { nodes: graph.nodes, edges: graph.edges },
        });
      } else {
        version = await api<BlueprintVersion>('/blueprints', {
          method: 'POST',
          json: { name, ...graph },
        });
      }
      await api(`/blueprints/${version.blueprintId}/versions/${version.version}/publish`, {
        method: 'POST',
      });
      setCurrentBlueprintId(version.blueprintId);
      setLoadedVersion(version.version);
      setDraftDirty(false);
      await blueprints.reload({ background: true });
      setNotice(`蓝图 v${version.version} 已发布；旧版本已归档。`);
      return true;
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : '发布失败');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const confirmSaveSimulation = async () => {
    if (!pendingSimulation) return;
    const pending = pendingSimulation;
    if (!(await save())) return;
    setPendingSimulation(undefined);
    await executeSimulatedInput(pending.nodeId, pending.text);
  };

  const toggleBlueprint = async (blueprint: Blueprint) => {
    if (blueprintAction) return;
    setBlueprintAction({ id: blueprint.id, kind: 'toggle' });
    const previous = blueprints.data;
    blueprints.setData((current) =>
      current.map((item) =>
        item.id === blueprint.id ? { ...item, enabled: !item.enabled } : item,
      ),
    );
    try {
      await apiRetry(
        `/blueprints/${blueprint.id}`,
        { method: 'PATCH', json: { enabled: !blueprint.enabled } },
        { attempts: 3 },
      );
      setNotice(`${blueprint.name} 已${blueprint.enabled ? '停用' : '启用'}。`);
    } catch (cause) {
      blueprints.setData(previous);
      setNotice(cause instanceof Error ? cause.message : '状态修改失败');
    } finally {
      setBlueprintAction(undefined);
    }
  };

  const deleteBlueprint = async (blueprint: Blueprint) => {
    if (!window.confirm(`确定删除蓝图“${blueprint.name}”及其全部版本吗？`)) return;
    if (blueprintAction) return;
    setBlueprintAction({ id: blueprint.id, kind: 'delete' });
    const previous = blueprints.data;
    blueprints.setData((current) => current.filter((item) => item.id !== blueprint.id));
    try {
      await apiRetry(`/blueprints/${blueprint.id}`, { method: 'DELETE' }, { attempts: 3 });
      if (currentBlueprintId === blueprint.id) resetEditor();
      setNotice(`${blueprint.name} 已删除。`);
    } catch (cause) {
      blueprints.setData(previous);
      setNotice(cause instanceof Error ? cause.message : '删除失败');
    } finally {
      setBlueprintAction(undefined);
    }
  };

  return (
    <div className="blueprint-layout">
      <div className="flow-toolbar">
        <div className="blueprint-library-head">
          <strong>已保存蓝图</strong>
          <button onClick={resetEditor}>
            <Plus size={14} />
            新建
          </button>
        </div>
        <div className="blueprint-library">
          {blueprints.data.map((blueprint) => (
            <div
              className={`blueprint-record ${
                currentBlueprintId === blueprint.id ? 'selected' : ''
              }`}
              key={blueprint.id}
            >
              <button className="blueprint-open" onClick={() => openBlueprint(blueprint)}>
                <span>{blueprint.name}</span>
                <small>
                  {blueprint.enabled ? '运行中' : '已停用'} · v{blueprint.activeVersion ?? '—'}
                </small>
              </button>
              <div className="blueprint-actions">
                <button
                  disabled={blueprintAction?.id === blueprint.id}
                  title={blueprint.enabled ? '停用' : '启用'}
                  onClick={() => void toggleBlueprint(blueprint)}
                >
                  {blueprintAction?.id === blueprint.id && blueprintAction.kind === 'toggle' ? (
                    <LoaderCircle className="spin" size={13} />
                  ) : (
                    <Power size={13} />
                  )}
                </button>
                <button
                  disabled={blueprintAction?.id === blueprint.id}
                  title="删除"
                  onClick={() => void deleteBlueprint(blueprint)}
                >
                  {blueprintAction?.id === blueprint.id && blueprintAction.kind === 'delete' ? (
                    <LoaderCircle className="spin" size={13} />
                  ) : (
                    <Trash2 size={13} />
                  )}
                </button>
              </div>
            </div>
          ))}
          {!blueprints.data.length && <small className="muted">尚无已保存蓝图</small>}
        </div>
        <div className="toolbar-divider" />
        <label>
          蓝图名称
          <input
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setDraftDirty(true);
            }}
          />
        </label>
        <label>
          选择会话
          <select value={selected} onChange={(event) => setSelected(event.target.value)}>
            <option value="">请选择</option>
            <optgroup label="模拟会话">
              <option value="__simulated-input__">模拟输入</option>
              <option value="__simulated-output__">模拟输出</option>
            </optgroup>
            <optgroup label="真实会话">
              {usable.map((session) => (
                <option key={session.id} value={session.id}>
                  {sessionLabel(session)}
                </option>
              ))}
            </optgroup>
          </select>
        </label>
        <div className="module-palette">
          <button onClick={() => addNode('input')}>
            <Plus size={15} />
            消息入口
          </button>
          <button onClick={() => addNode('output')}>
            <Plus size={15} />
            发送目标
          </button>
          <button onClick={() => addNode('translation')}>
            <Plus size={15} />
            翻译
          </button>
          <button onClick={() => addNode('moderation')}>
            <Plus size={15} />
            审核
          </button>
          <button onClick={() => addNode('review')}>
            <Plus size={15} />
            人工审核
          </button>
          <button onClick={() => addNode('fixed')}>
            <Plus size={15} />
            固定文本
          </button>
        </div>
        <button className="primary" disabled={saving} onClick={() => void save()}>
          {saving ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}
          {saving ? '发布中' : currentBlueprintId ? '发布新版本' : '保存并发布'}
        </button>
        {currentBlueprintId && loadedVersion !== undefined && (
          <small className="editing-version">正在编辑 v{loadedVersion}</small>
        )}
        {notice && <p className="toolbar-notice">{notice}</p>}
        <div className="tip">
          <Network size={18} />
          <p>
            <strong>连线方法</strong>
            <br />
            从左到右连接模块；可在会话列表选择模拟输入或模拟输出。模拟输入连接真实目标时会实际发送，真实入口也可连接模拟输出。所有运行中的消息都会逐节点播放。
          </p>
        </div>
      </div>
      <div className="flow-canvas">
        <ReactFlow
          key={editorKey}
          nodes={nodes.map((node) => ({
            ...node,
            data: {
              ...node.data,
              hasUnpublishedChanges: draftDirty,
              savePrompt: pendingSimulation?.nodeId === node.id,
              saveBusy: saving,
              simulationBusy,
              onDraftChange: () => setDraftDirty(true),
              onConfirmSaveSimulation: () => void confirmSaveSimulation(),
              onCancelSaveSimulation: () => setPendingSimulation(undefined),
              onSimulate: runSimulatedInput,
            },
          }))}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={(connection: Connection) => {
            setDraftDirty(true);
            setEdges((items) => addEdge({ ...connection, id: createBrowserId() }, items));
          }}
          onEdgeClick={(_event, edge) => {
            setDraftDirty(true);
            setEdges((items) => items.filter((item) => item.id !== edge.id));
          }}
          nodeTypes={nodeTypes}
          onInit={setFlowInstance}
          deleteKeyCode={['Backspace', 'Delete']}
          fitView
        >
          <Background color="#25282d" gap={24} />
          <MiniMap pannable zoomable nodeColor="#656b72" maskColor="rgb(13 15 17 / 76%)" />
          <Controls />
        </ReactFlow>
      </div>
      <MobileBlueprintFlow nodes={nodes} edges={edges} />
    </div>
  );
}

function Nodes() {
  const nodes = useLoad<NodeRuntime[]>('/nodes', []);
  const sessions = useLoad<ChatSession[]>('/chat-sessions', []);
  const [drafts, setDrafts] = useState<Record<string, { externalId: string; spaceId: string }>>({});
  const [adding, setAdding] = useState<Record<string, boolean>>({});
  const [verificationCodes, setVerificationCodes] = useState<Record<string, string>>({});
  const [notices, setNotices] = useState<Record<string, string>>({});
  const [sending, setSending] = useState<Record<string, boolean>>({});
  const [verifying, setVerifying] = useState<Record<string, boolean>>({});
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const configure = async (node: NodeRuntime) => {
    const draft = drafts[node.nodeId] ?? { externalId: '', spaceId: '' };
    const externalId = draft.externalId.trim();
    const spaceId = (node.nodeType === 'qq' ? externalId : draft.spaceId).trim();
    if (!externalId || !spaceId) {
      setNotices((current) => ({
        ...current,
        [node.nodeId]:
          node.nodeType === 'qq' ? '请填写 QQ 群号。' : '请填写 Discord 服务器 ID 和频道 ID。',
      }));
      return;
    }
    setSending((current) => ({ ...current, [node.nodeId]: true }));
    try {
      const session = await api<ChatSession>('/chat-sessions', {
        method: 'POST',
        json: {
          nodeId: node.nodeId,
          platform: node.nodeType,
          externalId,
          spaceId,
        },
      });
      const verification = await api<{ expiresAt: string }>(
        `/chat-sessions/${session.id}/send-code`,
        { method: 'POST' },
      );
      sessions.setData((current) => [
        ...current.filter((item) => item.id !== session.id),
        { ...session, verificationExpiresAt: verification.expiresAt },
      ]);
      setAdding((current) => ({ ...current, [node.nodeId]: false }));
      setDrafts((current) => ({ ...current, [node.nodeId]: { externalId: '', spaceId: '' } }));
      setNotices((current) => ({
        ...current,
        [node.nodeId]: '验证码已发送，请从目标群或频道读取后回填。',
      }));
    } catch (cause) {
      setNotices((current) => ({
        ...current,
        [node.nodeId]: cause instanceof Error ? cause.message : '配置失败',
      }));
    } finally {
      setSending((current) => ({ ...current, [node.nodeId]: false }));
    }
  };

  const verify = async (node: NodeRuntime, session: ChatSession) => {
    setVerifying((current) => ({ ...current, [session.id]: true }));
    try {
      const verified = await api<ChatSession>(`/chat-sessions/${session.id}/verify`, {
        method: 'POST',
        json: { code: verificationCodes[session.id] ?? '' },
      });
      sessions.setData((current) =>
        current.map((item) => (item.id === session.id ? { ...item, ...verified } : item)),
      );
      setVerificationCodes((current) => ({ ...current, [session.id]: '' }));
      setNotices((current) => ({ ...current, [node.nodeId]: '客户端与会话验证成功。' }));
    } catch (cause) {
      setNotices((current) => ({
        ...current,
        [node.nodeId]: cause instanceof Error ? cause.message : '验证码错误',
      }));
    } finally {
      setVerifying((current) => ({ ...current, [session.id]: false }));
    }
  };

  const resend = async (node: NodeRuntime, session: ChatSession) => {
    setSending((current) => ({ ...current, [session.id]: true }));
    try {
      const verification = await api<{ expiresAt: string }>(
        `/chat-sessions/${session.id}/send-code`,
        { method: 'POST' },
      );
      sessions.setData((current) =>
        current.map((item) =>
          item.id === session.id
            ? { ...item, verificationExpiresAt: verification.expiresAt }
            : item,
        ),
      );
      setNotices((current) => ({
        ...current,
        [node.nodeId]: '新验证码已发送，请从目标群或频道读取。',
      }));
    } catch (cause) {
      setNotices((current) => ({
        ...current,
        [node.nodeId]: cause instanceof Error ? cause.message : '重新发送失败',
      }));
    } finally {
      setSending((current) => ({ ...current, [session.id]: false }));
    }
  };

  const reload = async () => {
    await Promise.all([nodes.reload(), sessions.reload()]);
  };

  if (nodes.loading || sessions.loading) {
    return <LoadingState text="正在同步客户端和已绑定会话" />;
  }

  return (
    <div className="panel binding-panel">
      <PanelTitle
        title="客户端与会话"
        subtitle="填写目标会话 ID 后发送验证码；已绑定会话请在“聊天会话”页面查看和管理"
        action={
          <button className="icon-button" title="刷新" onClick={() => void reload()}>
            <RefreshCw size={16} />
          </button>
        }
      />
      <div className="node-list">
        {nodes.data.map((node) => {
          const pending = sessions.data.filter(
            (session) => session.nodeId === node.nodeId && session.status === 'pending',
          );
          const draft = drafts[node.nodeId] ?? { externalId: '', spaceId: '' };
          return (
            <section className="node-setup" key={node.nodeId}>
              <div className="binding-head">
                <Bot className={`platform-icon ${node.nodeType}`} size={20} />
                <div>
                  <h2>{node.nodeType === 'qq' ? 'QQ 客户端' : 'Discord 客户端'}</h2>
                  <p>{node.nodeId}</p>
                </div>
              </div>
              <div className="connection-state">
                <i className={node.online ? 'online' : ''} />
                {node.online ? '在线' : '离线'} · 可从客户端发现并绑定会话
              </div>

              {pending.map((session) => (
                <div className="verify-box" key={session.id}>
                  <div className="verify-title">
                    <strong>{sessionLabel(session)}</strong>
                    <span>
                      {session.verificationExpiresAt &&
                      Date.parse(session.verificationExpiresAt) > now
                        ? `验证码有效至 ${formatTime(session.verificationExpiresAt)}`
                        : '验证码已过期，请重新发送'}
                    </span>
                  </div>
                  <input
                    placeholder="回填频道或群内的验证码"
                    value={verificationCodes[session.id] ?? ''}
                    onChange={(event) =>
                      setVerificationCodes((current) => ({
                        ...current,
                        [session.id]: event.target.value,
                      }))
                    }
                  />
                  <button
                    className="verify-submit"
                    disabled={
                      Boolean(verifying[session.id]) || !verificationCodes[session.id]?.trim()
                    }
                    onClick={() => void verify(node, session)}
                  >
                    {verifying[session.id] && <LoaderCircle className="spin" size={15} />}
                    {verifying[session.id] ? '验证中' : '完成验证'}
                  </button>
                  <button
                    className="verify-resend"
                    disabled={Boolean(sending[session.id])}
                    onClick={() => void resend(node, session)}
                  >
                    {sending[session.id] && <LoaderCircle className="spin" size={14} />}
                    {sending[session.id] ? '发送中' : '重新发送验证码'}
                  </button>
                </div>
              ))}

              {adding[node.nodeId] ? (
                <div className="binding-form">
                  {node.nodeType === 'qq' ? (
                    <label>
                      QQ 群号
                      <input
                        inputMode="numeric"
                        autoComplete="off"
                        placeholder="例如 736770364"
                        value={draft.externalId}
                        onChange={(event) =>
                          setDrafts((current) => ({
                            ...current,
                            [node.nodeId]: {
                              externalId: event.target.value,
                              spaceId: event.target.value,
                            },
                          }))
                        }
                      />
                    </label>
                  ) : (
                    <div className="binding-fields">
                      <label>
                        Discord 服务器 ID
                        <input
                          inputMode="numeric"
                          autoComplete="off"
                          placeholder="例如 1108054453749301268"
                          value={draft.spaceId}
                          onChange={(event) =>
                            setDrafts((current) => ({
                              ...current,
                              [node.nodeId]: { ...draft, spaceId: event.target.value },
                            }))
                          }
                        />
                      </label>
                      <label>
                        Discord 频道 ID
                        <input
                          inputMode="numeric"
                          autoComplete="off"
                          placeholder="例如 1108054453749301271"
                          value={draft.externalId}
                          onChange={(event) =>
                            setDrafts((current) => ({
                              ...current,
                              [node.nodeId]: { ...draft, externalId: event.target.value },
                            }))
                          }
                        />
                      </label>
                    </div>
                  )}
                  <small>
                    {node.nodeType === 'qq'
                      ? '验证码会发送到这个 QQ 群。'
                      : '机器人必须已加入服务器，并拥有该频道的查看和发送消息权限；验证码发送失败时会显示具体原因。'}
                  </small>
                  <div className="binding-actions">
                    <button
                      className="primary"
                      disabled={
                        !node.online ||
                        !draft.externalId.trim() ||
                        (node.nodeType === 'discord' && !draft.spaceId.trim()) ||
                        Boolean(sending[node.nodeId])
                      }
                      onClick={() => void configure(node)}
                    >
                      {sending[node.nodeId] && <LoaderCircle className="spin" size={15} />}
                      {sending[node.nodeId] ? '发送中' : '发送验证码'}
                    </button>
                    <button
                      onClick={() => setAdding((current) => ({ ...current, [node.nodeId]: false }))}
                    >
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  className="add-binding"
                  disabled={!node.online}
                  onClick={() => setAdding((current) => ({ ...current, [node.nodeId]: true }))}
                >
                  <Plus size={15} />
                  绑定另一个会话
                </button>
              )}
              {notices[node.nodeId] && <div className="notice">{notices[node.nodeId]}</div>}
            </section>
          );
        })}
        {!nodes.data.length && <Empty text="尚无客户端；启动 QQ 或 Discord 客户端后会自动出现" />}
      </div>
    </div>
  );
}

type SettingsSection = 'llm' | 'delivery' | 'cards' | 'simulation';

interface LlmProviderForm {
  id: string;
  name: string;
  enabled: boolean;
  translationEnabled: boolean;
  moderationEnabled: boolean;
  imageModerationEnabled: boolean;
  baseUrl: string;
  apiKey: string;
  apiKeyConfigured: boolean;
  translationModel: string;
  moderationModel: string;
  imageModerationModel: string;
  imageModerationDetail: 'auto' | 'low' | 'high';
  maxImageCount: number;
  maxImageBytes: number;
  timeoutMs: number;
  maxRetries: number;
  retryDelayMs: number;
  maxTokens: number | '';
  translationTemperature: number;
  moderationTemperature: number;
  responseFormatMode: 'auto' | 'json-object' | 'json-schema';
}

type CardThemeLayoutView =
  'classic' | 'support' | 'timeline' | 'compact' | 'desktop' | 'board' | 'editorial' | 'minimal';

interface CardThemeView {
  id: string;
  name: string;
  description: string;
  dark: boolean;
  layout: CardThemeLayoutView;
  colors: {
    backgroundStart: string;
    backgroundMid: string;
    backgroundEnd: string;
    text: string;
    muted: string;
    accent: string;
    panel: string;
    panelBorder: string;
  };
}

interface CardSettingsView {
  themeId: string;
  themes: CardThemeView[];
}

const cardThemeFamilies: readonly {
  layout: CardThemeLayoutView;
  name: string;
  description: string;
}[] = [
  { layout: 'classic', name: '经典中继', description: '头像、身份和消息按自然阅读顺序展开。' },
  { layout: 'support', name: '客服工单', description: '独立页眉与醒目标记，适合问答和回复。' },
  { layout: 'timeline', name: '事件时间线', description: '用时间轴串起来源、正文和原消息。' },
  { layout: 'compact', name: '紧凑摘要', description: '缩短页眉与行距，同屏容纳更多信息。' },
  { layout: 'desktop', name: '桌面窗口', description: '带窗口标题栏和附件区域的桌面组件。' },
  { layout: 'board', name: '侧栏看板', description: '用窄侧轨区分平台，正文保持完整宽度。' },
  { layout: 'editorial', name: '杂志编排', description: '大标题、右侧头像与更宽松的内容节奏。' },
  { layout: 'minimal', name: '纯净文本', description: '去掉头像装饰，只保留必要身份和消息。' },
] as const;

function CardThemePreview({ theme }: { theme: CardThemeView }) {
  return (
    <span className={`theme-preview layout-${theme.layout}`} aria-hidden="true">
      {theme.layout === 'desktop' && (
        <span className="preview-windowbar">
          <i />
          <i />
          <i />
          <b>消息预览</b>
        </span>
      )}
      {theme.layout === 'board' && <span className="preview-board-rail">QQ</span>}
      {theme.layout === 'timeline' && <span className="preview-timeline-rail" />}
      {theme.layout !== 'minimal' && <span className="preview-avatar">林</span>}
      <span className="preview-identity">
        <strong>{theme.layout === 'support' ? '请求 #042' : '林屿'}</strong>
        <small>
          {theme.layout === 'timeline'
            ? '20:14 · Discord'
            : theme.layout === 'editorial'
              ? '来自 Discord 的新消息'
              : '项目讨论 · 20:14'}
        </small>
      </span>
      <span className="preview-platform">{theme.layout === 'board' ? '' : 'QQ'}</span>
      <span className="preview-body">
        {theme.layout === 'editorial'
          ? '今晚八点，继续把想法变成结果。'
          : theme.layout === 'compact'
            ? '文档已更新，今晚八点继续。'
            : theme.layout === 'minimal'
              ? '文档已更新。今晚八点继续讨论，附件在下一条。'
              : '文档已经更新，今晚八点继续讨论。'}
      </span>
      <span className="preview-reply">
        <b>{theme.layout === 'support' ? '回复内容' : '原消息'}</b>
        <small>收到，我会带着修改后的版本参加。</small>
      </span>
      {theme.layout === 'desktop' && <span className="preview-attachment">PNG · 1280 × 720</span>}
      {theme.layout === 'compact' && (
        <span className="preview-compact-meta">1 条回复 · 已转发</span>
      )}
    </span>
  );
}

function createProvider(index = 0): LlmProviderForm {
  return {
    id:
      typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `provider-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: `模型配置 ${index + 1}`,
    enabled: true,
    translationEnabled: true,
    moderationEnabled: true,
    imageModerationEnabled: true,
    baseUrl: '',
    apiKey: '',
    apiKeyConfigured: false,
    translationModel: '',
    moderationModel: '',
    imageModerationModel: '',
    imageModerationDetail: 'auto',
    maxImageCount: 10,
    maxImageBytes: 10 * 1024 * 1024,
    timeoutMs: 30_000,
    maxRetries: 2,
    retryDelayMs: 500,
    maxTokens: 2_048,
    translationTemperature: 0,
    moderationTemperature: 0,
    responseFormatMode: 'auto',
  };
}

function SettingsPage() {
  const settings = useLoad<Record<string, unknown>>('/settings/llm', {});
  const cards = useLoad<CardSettingsView>('/settings/card', { themeId: 'midnight', themes: [] });
  const simulation = useLoad<{ delayMs: number }>('/settings/simulation', { delayMs: 1_000 });
  const [section, setSection] = useState<SettingsSection>('llm');
  const [providers, setProviders] = useState<LlmProviderForm[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState('');
  const [concurrency, setConcurrency] = useState(4);
  const [fastMode, setFastMode] = useState(false);
  const [fastDeliveryIntervalMs, setFastDeliveryIntervalMs] = useState(1_500);
  const [themeId, setThemeId] = useState('midnight');
  const [simulationDelayMs, setSimulationDelayMs] = useState(1_000);
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!Object.keys(settings.data).length) return;
    const loaded = Array.isArray(settings.data.providers)
      ? (settings.data.providers as Array<Record<string, unknown>>).map(
          (provider, index) =>
            ({
              ...createProvider(index),
              ...provider,
              apiKey: '',
              apiKeyConfigured: Boolean(provider.apiKeyConfigured),
              maxTokens: typeof provider.maxTokens === 'number' ? provider.maxTokens : '',
            }) as LlmProviderForm,
        )
      : [];
    const next = loaded.length ? loaded : [createProvider(0)];
    setProviders(next);
    setSelectedProviderId((current) =>
      next.some((provider) => provider.id === current) ? current : next[0]!.id,
    );
    setConcurrency(Number(settings.data.concurrency ?? 4));
    setFastMode(Boolean(settings.data.fastMode));
    setFastDeliveryIntervalMs(Number(settings.data.fastDeliveryIntervalMs ?? 1_500));
  }, [settings.data]);
  useEffect(() => setThemeId(cards.data.themeId ?? 'midnight'), [cards.data.themeId]);
  useEffect(
    () => setSimulationDelayMs(simulation.data.delayMs ?? 1_000),
    [simulation.data.delayMs],
  );

  const selected = providers.find((provider) => provider.id === selectedProviderId) ?? providers[0];
  const markDirty = () => {
    setDirty(true);
    setNotice('');
  };
  const updateSelected = (patch: Partial<LlmProviderForm>) => {
    if (!selected) return;
    if (
      !Object.entries(patch).some(
        ([key, value]) => selected[key as keyof LlmProviderForm] !== value,
      )
    )
      return;
    markDirty();
    setProviders((current) =>
      current.map((provider) =>
        provider.id === selected.id ? { ...provider, ...patch } : provider,
      ),
    );
  };
  const moveSelected = (offset: -1 | 1) => {
    if (!selected) return;
    const selectedIndex = providers.findIndex((provider) => provider.id === selected.id);
    if (
      selectedIndex < 0 ||
      selectedIndex + offset < 0 ||
      selectedIndex + offset >= providers.length
    )
      return;
    markDirty();
    setProviders((current) => {
      const from = current.findIndex((provider) => provider.id === selected.id);
      const to = from + offset;
      if (from < 0 || to < 0 || to >= current.length) return current;
      const copy = [...current];
      [copy[from], copy[to]] = [copy[to]!, copy[from]!];
      return copy;
    });
  };
  const addProvider = () => {
    const provider = createProvider(providers.length);
    setProviders((current) => [...current, provider]);
    setSelectedProviderId(provider.id);
    markDirty();
  };
  const removeSelected = () => {
    if (!selected || providers.length <= 1) return;
    const index = providers.findIndex((provider) => provider.id === selected.id);
    const next = providers.filter((provider) => provider.id !== selected.id);
    setProviders(next);
    setSelectedProviderId(next[Math.min(index, next.length - 1)]!.id);
    markDirty();
  };
  useEffect(() => {
    if (!dirty) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeLeaving);
    return () => window.removeEventListener('beforeunload', warnBeforeLeaving);
  }, [dirty]);
  const save = async () => {
    setSaving(true);
    setNotice('');
    try {
      const [savedSettings, savedCards, savedSimulation] = await Promise.all([
        apiRetry<Record<string, unknown>>(
          '/settings/llm',
          {
            method: 'PUT',
            json: {
              providers: providers.map((provider) => ({
                id: provider.id,
                name: provider.name,
                enabled: provider.enabled,
                translationEnabled: provider.translationEnabled,
                moderationEnabled: provider.moderationEnabled,
                imageModerationEnabled: provider.imageModerationEnabled,
                baseUrl: provider.baseUrl,
                ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
                translationModel: provider.translationModel,
                moderationModel: provider.moderationModel,
                imageModerationModel: provider.imageModerationModel,
                imageModerationDetail: provider.imageModerationDetail,
                maxImageCount: provider.maxImageCount,
                maxImageBytes: provider.maxImageBytes,
                timeoutMs: provider.timeoutMs,
                maxRetries: provider.maxRetries,
                retryDelayMs: provider.retryDelayMs,
                ...(provider.maxTokens === '' ? {} : { maxTokens: provider.maxTokens }),
                translationTemperature: provider.translationTemperature,
                moderationTemperature: provider.moderationTemperature,
                responseFormatMode: provider.responseFormatMode,
              })),
              concurrency,
              fastMode,
              fastDeliveryIntervalMs,
            },
          },
          { attempts: 3 },
        ),
        apiRetry<CardSettingsView>(
          '/settings/card',
          { method: 'PUT', json: { themeId } },
          { attempts: 3 },
        ),
        apiRetry<{ delayMs: number }>(
          '/settings/simulation',
          { method: 'PUT', json: { delayMs: simulationDelayMs } },
          { attempts: 3 },
        ),
      ]);
      settings.setData(savedSettings);
      cards.setData(savedCards);
      simulation.setData(savedSimulation);
      setNotice('全部设置已保存；模型会按列表顺序故障转移，API 密钥不会回传。');
      setDirty(false);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  if (settings.loading || cards.loading || simulation.loading) {
    return <LoadingState text="正在读取基础设置" />;
  }
  const sections: Array<{ id: SettingsSection; label: string; hint: string; icon: typeof Bot }> = [
    { id: 'llm', label: '模型接入', hint: '多模型与故障转移', icon: Bot },
    { id: 'delivery', label: '投递性能', hint: '并发与疾速模式', icon: Gauge },
    {
      id: 'cards',
      label: '卡片主题',
      hint: `${cards.data.themes.length} 套本地主题`,
      icon: Palette,
    },
    { id: 'simulation', label: '模拟器', hint: '蓝图播放节奏', icon: FlaskConical },
  ];

  return (
    <div className="settings-page">
      <div className="settings-tabs" role="tablist" aria-label="设置功能区">
        {sections.map((item) => {
          const Icon = item.icon;
          return (
            <button
              className={section === item.id ? 'active' : ''}
              key={item.id}
              role="tab"
              aria-selected={section === item.id}
              onClick={() => setSection(item.id)}
            >
              <Icon size={18} />
              <span>
                <strong>{item.label}</strong>
                <small>{item.hint}</small>
              </span>
            </button>
          );
        })}
      </div>

      {notice && (
        <div className="settings-notice" role="status">
          {notice}
        </div>
      )}

      {section === 'llm' && (
        <div className="settings-provider-layout">
          <aside className="provider-list panel">
            <div className="provider-list-head">
              <div>
                <strong>调用顺序</strong>
                <small>失败后自动尝试下一项</small>
              </div>
              <button title="添加模型配置" onClick={addProvider}>
                <Plus size={16} />
              </button>
            </div>
            {providers.map((provider, index) => (
              <button
                className={`provider-record ${selected?.id === provider.id ? 'active' : ''}`}
                key={provider.id}
                onClick={() => setSelectedProviderId(provider.id)}
              >
                <span className={`provider-order ${provider.enabled ? '' : 'disabled'}`}>
                  {index + 1}
                </span>
                <span>
                  <strong>{provider.name || '未命名配置'}</strong>
                  <small>{provider.enabled ? provider.baseUrl || '等待填写地址' : '已停用'}</small>
                </span>
              </button>
            ))}
            <div className="provider-help">
              仅网络、额度、鉴权、格式等技术失败会切换下一项；模型成功返回的审核结论不会重试。
            </div>
          </aside>

          {selected && (
            <section className="panel provider-editor">
              <div className="provider-editor-head">
                <div>
                  <span>
                    优先级 {providers.findIndex((provider) => provider.id === selected.id) + 1}
                  </span>
                  <h2>{selected.name || '未命名配置'}</h2>
                </div>
                <div>
                  <button title="上移" onClick={() => moveSelected(-1)}>
                    <ArrowUp size={16} />
                  </button>
                  <button title="下移" onClick={() => moveSelected(1)}>
                    <ArrowDown size={16} />
                  </button>
                  <button
                    className="danger-text"
                    title="删除"
                    disabled={providers.length <= 1}
                    onClick={removeSelected}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
              <div className="form-grid">
                <label>
                  配置名称
                  <input
                    value={selected.name}
                    onChange={(event) => updateSelected({ name: event.target.value })}
                  />
                </label>
                <label className="provider-enabled">
                  启用状态
                  <span>
                    <input
                      type="checkbox"
                      checked={selected.enabled}
                      onChange={(event) => updateSelected({ enabled: event.target.checked })}
                    />
                    启用此模型配置
                  </span>
                  <small className="field-hint">关闭后不会用于任何任务，也不会进入备用队列。</small>
                </label>
                <fieldset className="wide provider-purpose">
                  <legend>承担任务</legend>
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.translationEnabled}
                      onChange={(event) =>
                        updateSelected({ translationEnabled: event.target.checked })
                      }
                    />
                    翻译
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.moderationEnabled}
                      onChange={(event) =>
                        updateSelected({ moderationEnabled: event.target.checked })
                      }
                    />
                    文本审核
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.imageModerationEnabled}
                      onChange={(event) =>
                        updateSelected({ imageModerationEnabled: event.target.checked })
                      }
                    />
                    图片审核
                  </label>
                  <small>
                    可以让便宜模型只翻译，让视觉模型只处理图片；每项都按左侧顺序独立故障转移。
                  </small>
                </fieldset>
                <label className="wide">
                  API 基础地址
                  <input
                    value={selected.baseUrl}
                    placeholder="https://api.example.com/v1"
                    onChange={(event) => updateSelected({ baseUrl: event.target.value })}
                  />
                </label>
                <label className="wide">
                  API 密钥
                  <input
                    type="password"
                    value={selected.apiKey}
                    placeholder={selected.apiKeyConfigured ? '已保存；留空表示不修改' : 'sk-…'}
                    onChange={(event) => updateSelected({ apiKey: event.target.value })}
                  />
                </label>
                <label>
                  翻译模型
                  <input
                    value={selected.translationModel}
                    onChange={(event) => updateSelected({ translationModel: event.target.value })}
                  />
                </label>
                <label>
                  文本审核模型
                  <input
                    value={selected.moderationModel}
                    onChange={(event) => updateSelected({ moderationModel: event.target.value })}
                  />
                </label>
                <label>
                  图片审核模型
                  <input
                    value={selected.imageModerationModel}
                    placeholder="留空则跳过该配置的图片审核"
                    onChange={(event) =>
                      updateSelected({ imageModerationModel: event.target.value })
                    }
                  />
                </label>
                <label>
                  图片细节级别
                  <select
                    value={selected.imageModerationDetail}
                    onChange={(event) =>
                      updateSelected({
                        imageModerationDetail: event.target
                          .value as LlmProviderForm['imageModerationDetail'],
                      })
                    }
                  >
                    <option value="auto">自动</option>
                    <option value="low">低（省 token）</option>
                    <option value="high">高</option>
                  </select>
                </label>
                <label>
                  单条最多图片数
                  <input
                    type="number"
                    min="1"
                    max="10"
                    value={selected.maxImageCount}
                    onChange={(event) =>
                      updateSelected({ maxImageCount: Number(event.target.value) })
                    }
                  />
                </label>
                <label>
                  单张图片上限（MB）
                  <input
                    type="number"
                    min="0.25"
                    max="20"
                    step="0.25"
                    value={Math.round((selected.maxImageBytes / 1024 / 1024) * 100) / 100}
                    onChange={(event) =>
                      updateSelected({
                        maxImageBytes: Math.round(Number(event.target.value) * 1024 * 1024),
                      })
                    }
                  />
                </label>
                <label>
                  超时（毫秒）
                  <input
                    type="number"
                    min="1000"
                    max="120000"
                    value={selected.timeoutMs}
                    onChange={(event) => updateSelected({ timeoutMs: Number(event.target.value) })}
                  />
                </label>
                <label>
                  内部重试次数
                  <input
                    type="number"
                    min="0"
                    max="5"
                    value={selected.maxRetries}
                    onChange={(event) => updateSelected({ maxRetries: Number(event.target.value) })}
                  />
                  <small className="field-hint">该项耗尽后才会切换下一配置。</small>
                </label>
                <label>
                  重试退避（毫秒）
                  <input
                    type="number"
                    min="0"
                    max="30000"
                    step="100"
                    value={selected.retryDelayMs}
                    onChange={(event) =>
                      updateSelected({ retryDelayMs: Number(event.target.value) })
                    }
                  />
                  <small className="field-hint">后续重试按该值指数递增，填 0 表示立即重试。</small>
                </label>
                <label>
                  最大输出 token
                  <input
                    type="number"
                    min="64"
                    max="65536"
                    value={selected.maxTokens}
                    placeholder="服务商默认"
                    onChange={(event) =>
                      updateSelected({
                        maxTokens: event.target.value === '' ? '' : Number(event.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  翻译温度
                  <input
                    type="number"
                    min="0"
                    max="2"
                    step="0.1"
                    value={selected.translationTemperature}
                    onChange={(event) =>
                      updateSelected({ translationTemperature: Number(event.target.value) })
                    }
                  />
                  <small className="field-hint">
                    建议 0；提高后措辞更多变，但 JSON 稳定性会降低。
                  </small>
                </label>
                <label>
                  审核温度
                  <input
                    type="number"
                    min="0"
                    max="2"
                    step="0.1"
                    value={selected.moderationTemperature}
                    onChange={(event) =>
                      updateSelected({ moderationTemperature: Number(event.target.value) })
                    }
                  />
                  <small className="field-hint">建议保持 0，让相同内容获得更稳定的判断。</small>
                </label>
                <label>
                  结构化输出格式
                  <select
                    value={selected.responseFormatMode}
                    onChange={(event) =>
                      updateSelected({
                        responseFormatMode: event.target
                          .value as LlmProviderForm['responseFormatMode'],
                      })
                    }
                  >
                    <option value="auto">自动识别</option>
                    <option value="json-object">JSON Object（兼容性高）</option>
                    <option value="json-schema">JSON Schema（约束更强）</option>
                  </select>
                  <small className="field-hint">
                    服务商报 response_format 错误时改成 JSON Object。
                  </small>
                </label>
              </div>
              <div className="safety-note">
                <ShieldCheck size={17} />
                <span>提示词和审核阈值仍在蓝图中配置；此处只管理连接、模型和容灾顺序。</span>
              </div>
            </section>
          )}
        </div>
      )}

      {section === 'delivery' && (
        <section className="panel settings-section-panel">
          <PanelTitle title="投递与性能" subtitle="这些设置作用于整个中央端和所有已连接节点" />
          <div className="form-grid">
            <label>
              LLM 并发数
              <input
                type="number"
                min="1"
                max="100"
                value={concurrency}
                onChange={(event) => {
                  setConcurrency(Number(event.target.value));
                  markDirty();
                }}
              />
              <small className="field-hint">限制中央端同时处理的消息数。</small>
            </label>
            <label>
              疾速发送间隔（毫秒）
              <input
                type="number"
                min="0"
                max="60000"
                step="100"
                value={fastDeliveryIntervalMs}
                onChange={(event) => {
                  setFastDeliveryIntervalMs(Number(event.target.value));
                  markDirty();
                }}
              />
              <small className="field-hint">同一目标会话连续发送的最小间隔。</small>
            </label>
            <label className="wide setting-toggle">
              <span>
                <input
                  type="checkbox"
                  checked={fastMode}
                  onChange={(event) => {
                    setFastMode(event.target.checked);
                    markDirty();
                  }}
                />{' '}
                疾速模式
              </span>
              <small className="field-hint">
                关闭图片下载与卡片合成，直接发文本。翻译与审核仍执行；任何处理故障会显示给收件人并继续投递。
              </small>
            </label>
          </div>
        </section>
      )}

      {section === 'cards' && (
        <section className="panel settings-section-panel card-theme-section">
          <PanelTitle
            title="消息卡片主题"
            subtitle="8 套版式 × 3 套配色；下方预览直接展示真实的文字层级、回复框和附件区域"
          />
          <div className="theme-family-list">
            {cardThemeFamilies.map((family) => {
              const familyThemes = cards.data.themes.filter(
                (theme) => theme.layout === family.layout,
              );
              if (!familyThemes.length) return null;
              return (
                <section className="theme-family" key={family.layout}>
                  <header>
                    <h3>{family.name}</h3>
                    <p>{family.description}</p>
                  </header>
                  <div className="theme-grid">
                    {familyThemes.map((theme) => (
                      <button
                        aria-pressed={themeId === theme.id}
                        className={`theme-choice ${themeId === theme.id ? 'selected' : ''}`}
                        key={theme.id}
                        onClick={() => {
                          if (themeId === theme.id) return;
                          setThemeId(theme.id);
                          markDirty();
                        }}
                        style={
                          {
                            '--theme-a': theme.colors.backgroundStart,
                            '--theme-b': theme.colors.backgroundEnd,
                            '--theme-text': theme.colors.text,
                            '--theme-muted': theme.colors.muted,
                            '--theme-accent': theme.colors.accent,
                            '--theme-panel': theme.colors.panel,
                            '--theme-border': theme.colors.panelBorder,
                          } as CSSProperties
                        }
                      >
                        <CardThemePreview theme={theme} />
                        <span className="theme-meta">
                          <strong>{theme.name}</strong>
                          <small>{theme.description}</small>
                        </span>
                        <span className="theme-kind">{theme.dark ? '暗色' : '亮色'}</span>
                        {themeId === theme.id && <Check className="theme-check" size={17} />}
                      </button>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        </section>
      )}

      {section === 'simulation' && (
        <section className="panel settings-section-panel">
          <PanelTitle
            title="蓝图模拟器"
            subtitle="只改变管理页面中的播放节奏，不影响真实消息延迟"
          />
          <div className="form-grid">
            <label>
              节点间隔（毫秒）
              <input
                type="number"
                min="0"
                max="10000"
                step="100"
                value={simulationDelayMs}
                onChange={(event) => {
                  setSimulationDelayMs(Number(event.target.value));
                  markDirty();
                }}
              />
            </label>
          </div>
        </section>
      )}

      {dirty && (
        <div className={`settings-savebar ${saving ? 'saving' : ''}`}>
          {saving && <i className="settings-save-progress" aria-hidden="true" />}
          <span>有尚未保存的修改；切换分栏不会丢失，离开页面前请保存。</span>
          <button className="primary fit" disabled={saving} onClick={() => void save()}>
            {saving ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}
            {saving ? '保存中' : '保存全部设置'}
          </button>
        </div>
      )}
    </div>
  );
}

function Records({ kind }: { kind: 'reviews' | 'logs' }) {
  return kind === 'reviews' ? <ReviewRecords /> : <LogRecords />;
}

function ReviewRecords() {
  const records = useLoad<Array<Record<string, unknown>>>('/reviews', []);
  const visibleRecords = records.data.filter((record) => record.status === 'pending');
  const decide = async (taskId: string, decision: 'approve' | 'reject') => {
    const previous = records.data;
    records.setData((current) =>
      current.map((record) =>
        record.taskId === taskId
          ? { ...record, status: decision === 'approve' ? 'approved' : 'rejected' }
          : record,
      ),
    );
    try {
      await apiRetry(
        `/reviews/${taskId}/decision`,
        { method: 'POST', json: { decision } },
        { attempts: 3 },
      );
      records.setError('');
    } catch (cause) {
      records.setData(previous);
      records.setError(cause instanceof Error ? cause.message : '审核操作失败');
    }
  };
  const clearReviews = async () => {
    if (!window.confirm('确定清除全部人工审核记录吗？仍在等待的消息将不会继续转发。')) return;
    const previous = records.data;
    records.setData([]);
    try {
      await apiRetry('/reviews', { method: 'DELETE' }, { attempts: 3 });
      records.setError('');
    } catch (cause) {
      records.setData(previous);
      records.setError(cause instanceof Error ? cause.message : '清除审核记录失败');
    }
  };
  return (
    <div className="panel">
      <PanelTitle
        title="待审核消息"
        subtitle="消息会停在人工审核节点；操作后从“通过”或“拦截”出口继续"
        action={
          <div className="log-actions">
            <button
              className="clear-button"
              disabled={!records.data.length}
              onClick={() => void clearReviews()}
            >
              <Trash2 size={15} />
              一键清除
            </button>
            <button className="icon-button" onClick={() => void records.reload()}>
              <RefreshCw size={16} />
            </button>
          </div>
        }
      />
      {records.error && <div className="panel-error">{records.error}</div>}
      {records.loading && <LoadingProgress text="正在读取待审核消息" />}
      <div className="record-list">
        {visibleRecords.map((record, index) => (
          <div className="record" key={String(record.taskId ?? record.id ?? index)}>
            <div>
              <strong>{translateLogEvent(String(record.reason ?? '审核任务'))}</strong>
              <span>{formatTime(String(record.createdAt ?? ''))}</span>
            </div>
            <code>{String(record.taskId ?? '')}</code>
            {record.status === 'pending' && (
              <div className="review-actions">
                <button onClick={() => void decide(String(record.taskId), 'reject')}>拦截</button>
                <button
                  className="approve"
                  onClick={() => void decide(String(record.taskId), 'approve')}
                >
                  批准转发
                </button>
              </div>
            )}
            <pre>{JSON.stringify(record, null, 2)}</pre>
          </div>
        ))}
        {!records.loading && !visibleRecords.length && <Empty text="目前没有待处理内容" />}
      </div>
    </div>
  );
}

type LogView = 'traces' | 'events';
type TraceFilter = 'all' | 'problems' | 'retry' | 'slow';
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface TraceLogGroup {
  traceId: string;
  level: LogLevel;
  event: string;
  startedAt: string;
  createdAt: string;
  durationMs: number;
  eventCount: number;
  events: Array<Record<string, unknown>>;
}

function LogRecords() {
  const [logLevel, setLogLevel] = useState('all');
  const [logSearch, setLogSearch] = useState('');
  const [logPage, setLogPage] = useState(1);
  const [logDevice, setLogDevice] = useState('central');
  const [logView, setLogView] = useState<LogView>('traces');
  const [traceFilter, setTraceFilter] = useState<TraceFilter>('all');
  const [expandedTraces, setExpandedTraces] = useState<Set<string>>(() => new Set());
  const [copiedTrace, setCopiedTrace] = useState('');
  const [live, setLive] = useState(true);
  const logNodes = useLoad<NodeRuntime[]>('/nodes', []);
  const isCentral = logDevice === 'central';
  const effectiveView: LogView = isCentral ? logView : 'events';
  const logPath = isCentral
    ? `/logs?page=${logPage}&pageSize=${effectiveView === 'traces' ? 20 : 50}&level=${encodeURIComponent(logLevel)}&search=${encodeURIComponent(logSearch)}&view=${effectiveView}&traceFilter=${traceFilter}`
    : `/node-logs?nodeId=${encodeURIComponent(logDevice)}&page=${logPage}&pageSize=50&level=${encodeURIComponent(logLevel === 'warn' || logLevel === 'error' ? logLevel : 'all')}&search=${encodeURIComponent(logSearch)}`;
  const logs = useLoad<LogPage>(logPath, {
    items: [],
    page: 1,
    pageSize: 50,
    total: 0,
    totalPages: 1,
  });
  const groups =
    effectiveView === 'traces'
      ? (logs.data.items.filter((item) => Array.isArray(item.events)) as unknown as TraceLogGroup[])
      : [];
  const rawRecords =
    effectiveView === 'events' ? logs.data.items.filter((item) => !Array.isArray(item.events)) : [];
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => void logs.reload({ background: true }), 5_000);
    return () => window.clearInterval(timer);
  }, [live, logs.reload]);
  const setDevice = (device: string) => {
    setLogDevice(device);
    setLogPage(1);
    setLogLevel('all');
    if (device !== 'central') setLogView('events');
  };
  const setView = (view: LogView) => {
    setLogView(view);
    setLogPage(1);
    setLogLevel('all');
    setTraceFilter('all');
  };
  const copyTraceId = async (traceId: string) => {
    try {
      await navigator.clipboard.writeText(traceId);
      setCopiedTrace(traceId);
      window.setTimeout(
        () => setCopiedTrace((current) => (current === traceId ? '' : current)),
        1_500,
      );
    } catch {
      setCopiedTrace('');
    }
  };
  const toggleTrace = (traceId: string) =>
    setExpandedTraces((current) => {
      const next = new Set(current);
      if (next.has(traceId)) next.delete(traceId);
      else next.add(traceId);
      return next;
    });
  const problemCount = groups.filter(
    (group) => group.level === 'warn' || group.level === 'error',
  ).length;
  const averageDuration = groups.length
    ? groups.reduce((total, group) => total + group.durationMs, 0) / groups.length
    : 0;
  return (
    <div className="panel log-panel">
      <PanelTitle
        title="运行日志"
        subtitle={
          effectiveView === 'traces'
            ? '每一项代表一条完整消息链路；点击任务查看处理时间线'
            : '按写入顺序查看未经聚合的底层事件'
        }
        action={
          <div className="log-actions">
            <select value={logDevice} onChange={(event) => setDevice(event.target.value)}>
              <option value="central">中央服务</option>
              {logNodes.data.map((node) => (
                <option key={node.nodeId} value={node.nodeId}>
                  {node.nodeType === 'qq' ? 'QQ 客户端' : 'Discord 客户端'} ·{' '}
                  {node.nodeId.slice(0, 8)}
                </option>
              ))}
            </select>
            <input
              className="log-search"
              value={logSearch}
              placeholder="traceId、消息 ID、用户或事件"
              onChange={(event) => {
                setLogSearch(event.target.value);
                setLogPage(1);
              }}
            />
            <button className="icon-button" title="立即刷新" onClick={() => void logs.reload()}>
              <RefreshCw size={16} />
            </button>
          </div>
        }
      />
      <div className="log-viewbar">
        <div className="log-view-switch" aria-label="日志显示方式">
          <button
            className={effectiveView === 'traces' ? 'active' : ''}
            disabled={!isCentral}
            onClick={() => setView('traces')}
          >
            消息任务
          </button>
          <button
            className={effectiveView === 'events' ? 'active' : ''}
            onClick={() => setView('events')}
          >
            原始事件
          </button>
        </div>
        {effectiveView === 'traces' ? (
          <div className="trace-filters">
            {(
              [
                ['all', '全部任务'],
                ['problems', '仅异常'],
                ['retry', '发生重试'],
                ['slow', '慢处理 ≥ 2 秒'],
              ] as const
            ).map(([id, label]) => (
              <button
                className={traceFilter === id ? 'active' : ''}
                key={id}
                onClick={() => {
                  setTraceFilter(id);
                  setLogPage(1);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        ) : (
          <select
            className="raw-level-filter"
            value={logLevel}
            onChange={(event) => {
              setLogLevel(event.target.value);
              setLogPage(1);
            }}
          >
            <option value="all">全部级别</option>
            {isCentral && <option value="debug">Debug</option>}
            {isCentral && <option value="info">Info</option>}
            <option value="warn">Warn</option>
            <option value="error">Error</option>
          </select>
        )}
        <button
          className={`live-toggle ${live ? 'active' : ''}`}
          onClick={() => setLive((current) => !current)}
        >
          {live ? <Pause size={14} /> : <Play size={14} />}
          {live ? '自动刷新' : '已暂停'}
        </button>
      </div>

      {logs.error && <div className="panel-error">{logs.error}</div>}
      {(logs.loading || logNodes.loading) && <LoadingProgress text="正在读取运行日志" />}

      {effectiveView === 'traces' && !logs.loading && groups.length > 0 && (
        <div className="trace-page-summary">
          <div>
            <span>本页任务</span>
            <strong>{groups.length}</strong>
          </div>
          <div>
            <span>异常任务</span>
            <strong>{problemCount}</strong>
          </div>
          <div>
            <span>平均耗时</span>
            <strong>{formatDuration(averageDuration)}</strong>
          </div>
        </div>
      )}

      {effectiveView === 'traces' ? (
        <div className="trace-list">
          {groups.map((group) => (
            <TraceLogCard
              copied={copiedTrace === group.traceId}
              expanded={expandedTraces.has(group.traceId)}
              group={group}
              key={group.traceId || `${group.createdAt}:${group.event}`}
              onCopy={() => void copyTraceId(group.traceId)}
              onToggle={() => toggleTrace(group.traceId)}
            />
          ))}
          {!logs.loading && !groups.length && <Empty text="没有匹配的消息任务" />}
        </div>
      ) : (
        <RawLogList records={rawRecords} loading={logs.loading} />
      )}

      {logs.data.totalPages > 1 && (
        <div className="log-pagination">
          <span>
            第 {logs.data.page} / {logs.data.totalPages} 页 · 共 {logs.data.total} 条
          </span>
          <div>
            <button
              disabled={logs.data.page <= 1}
              onClick={() => setLogPage((current) => Math.max(1, current - 1))}
            >
              上一页
            </button>
            <button
              disabled={logs.data.page >= logs.data.totalPages}
              onClick={() => setLogPage((current) => Math.min(logs.data.totalPages, current + 1))}
            >
              下一页
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function TraceLogCard({
  group,
  expanded,
  copied,
  onToggle,
  onCopy,
}: {
  group: TraceLogGroup;
  expanded: boolean;
  copied: boolean;
  onToggle: () => void;
  onCopy: () => void;
}) {
  const state = traceState(group);
  const route = traceRoute(group.events);
  const count = traceMessageCount(group.events);
  const start = Date.parse(group.startedAt);
  return (
    <article className={`trace-card ${state.id} ${expanded ? 'expanded' : ''}`}>
      <button className="trace-card-summary" aria-expanded={expanded} onClick={onToggle}>
        <span className="trace-state-icon">
          {state.id === 'error' || state.id === 'warn' ? (
            <CircleAlert size={17} />
          ) : (
            <Check size={17} />
          )}
        </span>
        <span className="trace-primary">
          <span className="trace-title-row">
            <strong>{route || '消息处理任务'}</strong>
            <span className={`trace-status ${state.id}`}>{state.label}</span>
          </span>
          <span className="trace-subtitle">
            {traceMessagePreview(group.events)} · {translateLogEvent(group.event)} · {count} 条消息
            · {group.eventCount} 个步骤
          </span>
        </span>
        <span className="trace-numbers">
          <time>{formatTime(group.createdAt)}</time>
          <span>{formatDuration(group.durationMs)}</span>
        </span>
        <ChevronDown className="trace-chevron" size={17} />
      </button>
      {expanded && (
        <div className="trace-card-body">
          <div className="trace-identity">
            <span>追踪号</span>
            <code title={group.traceId}>{shortTraceId(group.traceId)}</code>
            <button title="复制完整追踪号" disabled={!group.traceId} onClick={onCopy}>
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? '已复制' : '复制'}
            </button>
          </div>
          <div className="trace-timeline">
            {group.events.map((record, index) => {
              const createdAt = String(record.createdAt ?? '');
              const timestamp = Date.parse(createdAt);
              const delta =
                Number.isFinite(start) && Number.isFinite(timestamp) ? timestamp - start : 0;
              const level = normalizeLogLevel(record.level);
              return (
                <details
                  className={`trace-step ${level}`}
                  key={String(record.id ?? `${createdAt}:${String(record.event)}:${index}`)}
                >
                  <summary>
                    <i />
                    <time>+{formatDuration(delta)}</time>
                    <strong>{translateLogEvent(String(record.event ?? 'unknown'))}</strong>
                    {(level === 'warn' || level === 'error') && (
                      <span className={`log-level ${level}`}>{level.toUpperCase()}</span>
                    )}
                    <code>{String(record.event ?? '')}</code>
                    <ChevronRight size={14} />
                  </summary>
                  <div className="trace-step-detail">
                    <span>{formatTime(createdAt)}</span>
                    <pre>{JSON.stringify(record.details ?? {}, null, 2)}</pre>
                  </div>
                </details>
              );
            })}
          </div>
        </div>
      )}
    </article>
  );
}

function RawLogList({
  records,
  loading,
}: {
  records: Array<Record<string, unknown>>;
  loading: boolean;
}) {
  return (
    <div className="raw-log-list">
      {records.map((record, index) => {
        const level = normalizeLogLevel(record.level);
        return (
          <details className={`raw-log-record ${level}`} key={String(record.id ?? index)}>
            <summary>
              <span className={`log-level ${level}`}>{level.toUpperCase()}</span>
              <strong>{translateLogEvent(String(record.event ?? 'unknown'))}</strong>
              <span className="log-message-preview">{logMessagePreview(record)}</span>
              <code title={String(record.traceId ?? '')}>
                {shortTraceId(String(record.traceId ?? ''))}
              </code>
              <time>{formatTime(String(record.createdAt ?? ''))}</time>
              <ChevronRight size={14} />
            </summary>
            <pre>{JSON.stringify(record, null, 2)}</pre>
          </details>
        );
      })}
      {!loading && !records.length && <Empty text="暂无日志" />}
    </div>
  );
}

function traceState(group: TraceLogGroup): {
  id: 'success' | 'running' | 'waiting' | 'warn' | 'error';
  label: string;
} {
  const events = new Set(group.events.map((record) => String(record.event ?? '')));
  if (group.level === 'error') {
    if (events.has('delivery_succeeded')) return { id: 'error', label: '异常后完成' };
    if (events.has('delivery_queued')) return { id: 'error', label: '异常后继续' };
    return { id: 'error', label: '失败' };
  }
  if (group.level === 'warn') {
    if (
      events.has('delivery_succeeded') ||
      events.has('message_upload_batch_completed') ||
      events.has('blueprint_completed')
    )
      return { id: 'warn', label: '重试后完成' };
    return { id: 'warn', label: '需要注意' };
  }
  if (events.has('manual_review_created') || events.has('blueprint_paused'))
    return { id: 'waiting', label: '等待处理' };
  if (
    [...events].some((event) =>
      ['delivery_succeeded', 'message_upload_batch_completed', 'blueprint_completed'].includes(
        event,
      ),
    )
  )
    return { id: 'success', label: '已完成' };
  return { id: 'running', label: '处理中' };
}

function traceRoute(events: Array<Record<string, unknown>>): string {
  let source = '';
  let target = '';
  for (const record of events) {
    const details = asRecord(record.details);
    const message = asRecord(details.message);
    const messageSource = asRecord(message.source);
    const deliveryTarget = asRecord(details.target);
    source ||= platformLabel(
      messageSource.platform ?? asRecord(details.authenticatedNode).nodeType,
    );
    target ||= platformLabel(deliveryTarget.platform);
  }
  if (source && target) return `${source} → ${target}`;
  if (source) return `${source} 消息任务`;
  if (target) return `发往 ${target}`;
  return '';
}

function traceMessageCount(events: Array<Record<string, unknown>>): number {
  let count = 1;
  for (const record of events) {
    const details = asRecord(record.details);
    for (const value of [details.batchSize, details.messageCount, details.deliveryCount]) {
      if (typeof value === 'number' && Number.isFinite(value)) count = Math.max(count, value);
    }
  }
  return count;
}

function traceMessagePreview(events: Array<Record<string, unknown>>): string {
  for (const record of events) {
    const preview = logMessagePreview(record, '');
    if (preview) return preview;
  }
  return '—';
}

function logMessagePreview(record: Record<string, unknown>, fallback = '—'): string {
  const details = asRecord(record.details);
  const direct = typeof details.messagePreview === 'string' ? details.messagePreview : '';
  if (direct.trim()) return compactMessagePreview(direct, false);
  if (Array.isArray(details.messagePreviews)) {
    const first = details.messagePreviews.find(
      (value): value is string => typeof value === 'string' && Boolean(value.trim()),
    );
    if (first) return compactMessagePreview(first, false);
  }
  const message = asRecord(details.message);
  const text = typeof message.text === 'string' ? message.text : undefined;
  const hasImage = Array.isArray(message.attachments) && message.attachments.length > 0;
  if (text?.trim() || hasImage) return compactMessagePreview(text, hasImage);
  return fallback;
}

function compactMessagePreview(text: string | undefined, hasImage: boolean): string {
  const normalized = text?.replace(/\s+/gu, ' ').trim();
  if (normalized) return [...normalized].slice(0, 8).join('');
  return hasImage ? '[图片]' : '—';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function platformLabel(value: unknown): string {
  return String(value ?? '').toLowerCase() === 'discord'
    ? 'Discord'
    : String(value ?? '').toLowerCase() === 'qq'
      ? 'QQ'
      : '';
}

function normalizeLogLevel(value: unknown): LogLevel {
  const level = String(value ?? 'info');
  return level === 'debug' || level === 'warn' || level === 'error' ? level : 'info';
}

function shortTraceId(traceId: string): string {
  if (!traceId) return '无追踪号';
  return traceId.length > 12 ? `${traceId.slice(0, 8)}…` : traceId;
}

function formatDuration(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0ms';
  if (value < 1_000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`;
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1_000)}s`;
}

function PanelTitle({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle: string;
  action?: ReactNode;
}) {
  return (
    <div className="panel-title">
      <div>
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>
      {action}
    </div>
  );
}
function Empty({ text }: { text: string }) {
  return (
    <div className="empty">
      <span>{text}</span>
    </div>
  );
}
function LoadingState({ text }: { text: string }) {
  return (
    <div className="loading-state" role="status" aria-live="polite">
      <LoaderCircle size={20} />
      <span>{text}</span>
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
function formatTime(value?: string) {
  if (!value) return '暂无记录';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString('zh-CN', { hour12: false });
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
  delivery_succeeded: '消息发送成功',
  delivery_failed: '消息发送失败',
  node_logs_sent: '客户端日志已回传',
  blueprint_started: '蓝图开始处理',
  blueprint_completed: '蓝图处理完成',
  blueprint_failed: '蓝图处理失败',
  blueprint_invalid: '蓝图配置无效',
  blueprint_node_entered: '进入蓝图节点',
  blueprint_paused: '蓝图已暂停',
  message_received: '收到消息',
  message_deduplicated: '重复消息已忽略',
  message_discarded: '消息已丢弃',
  source_session_matched: '已匹配来源会话',
  unmatched_blueprint: '没有匹配的蓝图',
  unmatched_session: '没有匹配的会话',
  translation_requested: '请求翻译',
  translation_response: '收到翻译结果',
  translation_failed: '翻译失败',
  llm_request_failed: '大模型请求失败',
  moderation_requested: '请求审核',
  moderation_response: '收到审核结果',
  moderation_failed: '审核失败',
  manual_review_created: '已创建人工审核任务',
  manual_review_resolved: '人工审核任务已处理',
  render_succeeded: '图片合成成功',
  fixed_text_applied: '已替换为固定文本',
  delivery_command_failed: '发送命令失败',
};

function translateLogEvent(event: string): string {
  return logEventLabels[event] ?? event.replaceAll('_', ' ');
}

function createBrowserId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20)}`;
}

const root = document.querySelector('#root');
if (!root) throw new Error('Missing #root element');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
