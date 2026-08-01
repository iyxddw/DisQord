import {
  StrictMode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
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
  Bot,
  Check,
  ChevronRight,
  CircleAlert,
  FileClock,
  LogOut,
  LoaderCircle,
  MessagesSquare,
  Network,
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
  type AuthStatus,
  type Blueprint,
  type BlueprintActivity,
  type BlueprintActivityPage,
  type BlueprintVersion,
  type ChatSession,
  type NodeRuntime,
  type SessionCandidate,
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

function useLoad<T>(path: string, fallback: T) {
  const [data, setData] = useState<T>(fallback);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api<T>(path));
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [path]);
  useEffect(() => void reload(), [reload]);
  return { data, error, loading, reload, setData };
}

function App() {
  const [auth, setAuth] = useState<AuthStatus>();
  const [page, setPage] = useState<Page>('overview');
  useEffect(() => {
    void api<AuthStatus>('/auth/status')
      .then(setAuth)
      .catch(() => setAuth({ configured: false, authenticated: false }));
  }, []);

  if (!auth) return <Splash />;
  if (!auth.authenticated) {
    return (
      <Login
        configured={auth.configured}
        onDone={() => setAuth({ configured: true, authenticated: true })}
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
          {page === 'settings' && <LlmSettings />}
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

function Login({ configured, onDone }: { configured: boolean; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const submit = async () => {
    try {
      await api(configured ? '/auth/login' : '/auth/setup', { method: 'POST', json: { password } });
      onDone();
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
          <div className="error">
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
  const { data, reload, error, loading } = useLoad<ChatSession[]>('/chat-sessions', []);
  const [editingId, setEditingId] = useState('');
  const [remark, setRemark] = useState('');
  const saveRemark = async (session: ChatSession) => {
    await api(`/chat-sessions/${session.id}`, {
      method: 'PATCH',
      json: { remark: remark.trim() || null },
    });
    setEditingId('');
    await reload();
  };
  const remove = async (session: ChatSession) => {
    if (!window.confirm(`确定删除会话“${sessionLabel(session)}”吗？引用它的蓝图需要重新编辑。`))
      return;
    await api(`/chat-sessions/${session.id}`, { method: 'DELETE' });
    await reload();
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
      {error && <div className="error">{error}</div>}
      {loading && <LoadingState text="正在读取聊天会话" />}
      <div className="list">
        {data.map((session) => (
          <div className="session-row" key={session.id}>
            <div className={`platform ${session.platform}`}>
              <MessagesSquare size={18} />
            </div>
            <div className="grow">
              <strong>{sessionLabel(session)}</strong>
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
type FlowData = {
  label: string;
  kind: FlowKind;
  sessionId?: string;
  prompt?: string;
  memoryMode?: boolean;
  threshold?: number;
  text?: string;
  outputText?: string;
  busy?: boolean;
  onSimulate?: (nodeId: string, text: string) => Promise<void>;
  simulation?:
    | {
        state: 'active' | 'done' | 'error';
        message: string;
      }
    | undefined;
};

const defaultTranslationPrompt =
  '请将消息自然、准确地翻译成目标聊天使用的语言。保留姓名、@提及、网址、代码、Emoji、换行和语气，不要回答、解释、审查或概括消息。';
const defaultModerationPrompt =
  '请评估文本的违规程度。正常对话应接近 0，明确严重违规应接近 1。重点考虑骚扰、仇恨、色情、暴力、自残、违法活动、隐私泄露和垃圾信息。';

function FlowNode({ id, data }: NodeProps<Node<FlowData>>) {
  const { deleteElements, updateNodeData } = useReactFlow();
  const [testText, setTestText] = useState('');
  const hasInput = data.kind !== 'input' && data.kind !== 'simulated-input';
  const hasOutput =
    data.kind !== 'output' &&
    data.kind !== 'simulated-output' &&
    data.kind !== 'moderation' &&
    data.kind !== 'review';
  return (
    <div className={`flow-node ${data.kind} ${data.simulation?.state ?? ''}`}>
      {data.simulation && (
        <div className={`flow-simulation-note ${data.simulation.state}`} role="status">
          {data.simulation.message}
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
      {data.kind === 'simulated-output' && (
        <div className="simulated-output-value nodrag nopan">
          {data.outputText || '等待流程输出…'}
        </div>
      )}
      {data.kind === 'translation' && (
        <div className="flow-node-config nodrag nopan">
          <textarea
            value={data.prompt ?? ''}
            onChange={(event) => updateNodeData(id, { prompt: event.target.value })}
            placeholder="翻译提示词"
          />
          <label className="memory-toggle">
            <input
              type="checkbox"
              checked={Boolean(data.memoryMode)}
              onChange={(event) => updateNodeData(id, { memoryMode: event.target.checked })}
            />
            <span>记忆模式</span>
          </label>
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
              onChange={(event) => updateNodeData(id, { threshold: Number(event.target.value) })}
            />
          </label>
          <textarea
            value={data.prompt ?? ''}
            onChange={(event) => updateNodeData(id, { prompt: event.target.value })}
            placeholder="审核提示词"
          />
        </div>
      )}
      {data.kind === 'fixed' && (
        <div className="flow-node-config nodrag nopan">
          <textarea
            value={data.text ?? ''}
            onChange={(event) => updateNodeData(id, { text: event.target.value })}
            placeholder="经过此模块后输出的固定文本"
          />
        </div>
      )}
      <button
        className="flow-node-delete nodrag nopan"
        title="删除节点"
        aria-label={`删除${data.label}`}
        onClick={() => void deleteElements({ nodes: [{ id }] })}
      >
        <Trash2 size={13} />
      </button>
    </div>
  );
}

function BlueprintEditor() {
  const sessions = useLoad<ChatSession[]>('/chat-sessions', []);
  const blueprints = useLoad<Blueprint[]>('/blueprints', []);
  const usable = sessions.data.filter((item) => item.status === 'verified');
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<FlowData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [name, setName] = useState('双向翻译');
  const [selected, setSelected] = useState('');
  const [currentBlueprintId, setCurrentBlueprintId] = useState('');
  const [loadedVersion, setLoadedVersion] = useState<number>();
  const [editorKey, setEditorKey] = useState(0);
  const [notice, setNotice] = useState('');
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<Node<FlowData>, Edge>>();
  const activityCursor = useRef('');
  const activityQueue = useRef<BlueprintActivity[]>([]);
  const activityPlaying = useRef(false);
  const nodeTypes = useMemo(() => ({ session: FlowNode }), []);

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
    let polling = false;
    activityCursor.current = '';
    activityQueue.current = [];

    const playQueued = async () => {
      if (activityPlaying.current) return;
      activityPlaying.current = true;
      while (!cancelled && activityQueue.current.length) {
        const activity = activityQueue.current.shift()!;
        setNodes((current) =>
          current.map((node) => ({
            ...node,
            data: {
              ...node.data,
              ...(node.id === activity.nodeId && activity.nodeType === 'simulated-output'
                ? { outputText: activity.text ?? '' }
                : {}),
              simulation:
                node.id === activity.nodeId
                  ? { state: 'active' as const, message: activity.message }
                  : node.data.simulation?.state === 'active'
                    ? { ...node.data.simulation, state: 'done' as const }
                    : node.data.simulation,
            },
          })),
        );
        await new Promise((resolve) => window.setTimeout(resolve, 1_000));
        setNodes((current) =>
          current.map((node) =>
            node.id === activity.nodeId
              ? {
                  ...node,
                  data: {
                    ...node.data,
                    simulation: node.data.simulation
                      ? { ...node.data.simulation, state: 'done' as const }
                      : undefined,
                  },
                }
              : node,
          ),
        );
      }
      activityPlaying.current = false;
    };

    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const page = await api<BlueprintActivityPage>(
          `/blueprints/${currentBlueprintId}/activity?cursor=${encodeURIComponent(activityCursor.current)}`,
        );
        if (cancelled) return;
        activityCursor.current = page.cursor;
        if (!initialized) {
          initialized = true;
          const latestOutputs = new Map<string, string>();
          for (const activity of page.items) {
            if (activity.nodeType === 'simulated-output') {
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
          return;
        }
        activityQueue.current.push(...page.items);
        void playQueued();
      } catch {
        // 页面会继续轮询；短暂断线无需打断蓝图编辑。
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 700);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      activityQueue.current = [];
      activityPlaying.current = false;
    };
  }, [currentBlueprintId, setNodes]);

  if (sessions.loading || blueprints.loading) {
    return <LoadingState text="正在载入蓝图和会话" />;
  }

  const resetEditor = () => {
    setCurrentBlueprintId('');
    setLoadedVersion(undefined);
    setName('双向翻译');
    setNodes([]);
    setEdges([]);
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
            ...(typeof node.config.prompt === 'string' ? { prompt: node.config.prompt } : {}),
            ...(typeof node.config.memoryMode === 'boolean'
              ? { memoryMode: node.config.memoryMode }
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
      },
      moderation: {
        kind: 'moderation',
        label: '按违规分数分流',
        prompt: defaultModerationPrompt,
        threshold: 0.5,
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
    setNodes((current) => [
      ...current,
      {
        id: createBrowserId(),
        type: 'session',
        position: {
          x: column === 'input' ? 60 : column === 'output' ? 920 : 360,
          y: 70 + columnCount * (column === 'processor' ? 230 : 165),
        },
        data,
      },
    ]);
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
        node.data.kind === 'input' || node.data.kind === 'output'
          ? { sessionId: node.data.sessionId }
          : node.data.kind === 'translation'
            ? { prompt: node.data.prompt, memoryMode: Boolean(node.data.memoryMode) }
            : node.data.kind === 'moderation'
              ? { prompt: node.data.prompt, threshold: node.data.threshold ?? 0.5 }
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

  const runSimulatedInput = async (nodeId: string, text: string) => {
    if (!currentBlueprintId || loadedVersion === undefined) {
      setNotice('请先保存并发布蓝图，再从模拟输入节点发送消息。');
      return;
    }
    setNodes((current) =>
      current.map((node) =>
        node.id === nodeId ? { ...node, data: { ...node.data, busy: true } } : node,
      ),
    );
    try {
      await api(`/blueprints/${currentBlueprintId}/simulated-input/${nodeId}`, {
        method: 'POST',
        json: { text },
      });
      setNotice('模拟消息已运行；若流程连接到真实发送目标，消息也已实际发送。');
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : '模拟消息运行失败');
    } finally {
      setNodes((current) =>
        current.map((node) =>
          node.id === nodeId ? { ...node, data: { ...node.data, busy: false } } : node,
        ),
      );
    }
  };

  const save = async () => {
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
      await blueprints.reload();
      setNotice(`蓝图 v${version.version} 已发布；旧版本已归档。`);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : '发布失败');
    }
  };

  const toggleBlueprint = async (blueprint: Blueprint) => {
    try {
      await api(`/blueprints/${blueprint.id}`, {
        method: 'PATCH',
        json: { enabled: !blueprint.enabled },
      });
      await blueprints.reload();
      setNotice(`${blueprint.name} 已${blueprint.enabled ? '停用' : '启用'}。`);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : '状态修改失败');
    }
  };

  const deleteBlueprint = async (blueprint: Blueprint) => {
    if (!window.confirm(`确定删除蓝图“${blueprint.name}”及其全部版本吗？`)) return;
    try {
      await api(`/blueprints/${blueprint.id}`, { method: 'DELETE' });
      if (currentBlueprintId === blueprint.id) resetEditor();
      await blueprints.reload();
      setNotice(`${blueprint.name} 已删除。`);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : '删除失败');
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
                  title={blueprint.enabled ? '停用' : '启用'}
                  onClick={() => void toggleBlueprint(blueprint)}
                >
                  <Power size={13} />
                </button>
                <button title="删除" onClick={() => void deleteBlueprint(blueprint)}>
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
          {!blueprints.data.length && <small className="muted">尚无已保存蓝图</small>}
        </div>
        <div className="toolbar-divider" />
        <label>
          蓝图名称
          <input value={name} onChange={(event) => setName(event.target.value)} />
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
        <button className="primary" onClick={() => void save()}>
          <Save size={16} />
          {currentBlueprintId ? '发布新版本' : '保存并发布'}
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
            data: { ...node.data, onSimulate: runSimulatedInput },
          }))}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={(connection: Connection) =>
            setEdges((items) => addEdge({ ...connection, id: createBrowserId() }, items))
          }
          onEdgeClick={(_event, edge) =>
            setEdges((items) => items.filter((item) => item.id !== edge.id))
          }
          nodeTypes={nodeTypes}
          onInit={setFlowInstance}
          deleteKeyCode={['Backspace', 'Delete']}
          fitView
        >
          <Background color="#25282d" gap={24} />
          <MiniMap
            pannable
            zoomable
            nodeColor="#656b72"
            maskColor="rgb(13 15 17 / 76%)"
          />
          <Controls />
        </ReactFlow>
      </div>
    </div>
  );
}

function Nodes() {
  const nodes = useLoad<NodeRuntime[]>('/nodes', []);
  const sessions = useLoad<ChatSession[]>('/chat-sessions', []);
  const candidates = useLoad<SessionCandidate[]>('/chat-sessions/candidates', []);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState<Record<string, boolean>>({});
  const [verificationCodes, setVerificationCodes] = useState<Record<string, string>>({});
  const [notices, setNotices] = useState<Record<string, string>>({});

  const configure = async (node: NodeRuntime) => {
    const candidate = candidates.data.find(
      (item) => item.nodeId === node.nodeId && candidateKey(item) === drafts[node.nodeId],
    );
    if (!candidate) {
      setNotices((current) => ({ ...current, [node.nodeId]: '请先选择一个会话。' }));
      return;
    }
    try {
      const session = await api<ChatSession>('/chat-sessions', {
        method: 'POST',
        json: candidate,
      });
      await api(`/chat-sessions/${session.id}/send-code`, { method: 'POST' });
      setAdding((current) => ({ ...current, [node.nodeId]: false }));
      setDrafts((current) => ({ ...current, [node.nodeId]: '' }));
      setNotices((current) => ({
        ...current,
        [node.nodeId]: '验证码已发送，请从目标群或频道读取后回填。',
      }));
      await sessions.reload();
    } catch (cause) {
      setNotices((current) => ({
        ...current,
        [node.nodeId]: cause instanceof Error ? cause.message : '配置失败',
      }));
    }
  };

  const verify = async (node: NodeRuntime, session: ChatSession) => {
    try {
      await api(`/chat-sessions/${session.id}/verify`, {
        method: 'POST',
        json: { code: verificationCodes[session.id] ?? '' },
      });
      setNotices((current) => ({ ...current, [node.nodeId]: '客户端与会话验证成功。' }));
      await Promise.all([sessions.reload(), nodes.reload()]);
    } catch (cause) {
      setNotices((current) => ({
        ...current,
        [node.nodeId]: cause instanceof Error ? cause.message : '验证码错误',
      }));
    }
  };

  const reload = async () => {
    await Promise.all([nodes.reload(), sessions.reload(), candidates.reload()]);
  };

  if (nodes.loading || sessions.loading || candidates.loading) {
    return <LoadingState text="正在同步客户端和可绑定会话" />;
  }

  return (
    <div className="panel binding-panel">
      <PanelTitle
        title="客户端与会话"
        subtitle="每个客户端可以验证并绑定多个群或频道"
        action={
          <button className="icon-button" title="刷新" onClick={() => void reload()}>
            <RefreshCw size={16} />
          </button>
        }
      />
      <div className="node-list">
        {nodes.data.map((node) => {
          const verified = sessions.data.filter(
            (session) => session.nodeId === node.nodeId && session.status === 'verified',
          );
          const pending = sessions.data.filter(
            (session) => session.nodeId === node.nodeId && session.status === 'pending',
          );
          const used = new Set([...verified, ...pending].map((session) => session.externalId));
          const available = candidates.data.filter(
            (candidate) => candidate.nodeId === node.nodeId && !used.has(candidate.externalId),
          );
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
                {node.online ? '在线' : '离线'} · 已绑定 {verified.length} 个会话
              </div>

              <div className="bound-session-list">
                {verified.map((session) => (
                  <div className="bound-session" key={session.id}>
                    <div>
                      <strong>{sessionLabel(session)}</strong>
                      <span>
                        {session.remark ? `原名：${session.displayName}` : '已验证，可在蓝图中使用'}
                      </span>
                    </div>
                    <span className="badge success">
                      <Check size={13} />
                      已绑定
                    </span>
                  </div>
                ))}
                {!verified.length && <Empty text="这个客户端还没有已绑定会话" />}
              </div>

              {pending.map((session) => (
                <div className="verify-box" key={session.id}>
                  <strong>{sessionLabel(session)}</strong>
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
                  <button onClick={() => void verify(node, session)}>完成验证</button>
                </div>
              ))}

              {adding[node.nodeId] ? (
                <div className="binding-form">
                  <label>
                    选择客户端可见的会话
                    <select
                      value={drafts[node.nodeId] ?? ''}
                      onChange={(event) =>
                        setDrafts((current) => ({ ...current, [node.nodeId]: event.target.value }))
                      }
                    >
                      <option value="">请选择</option>
                      {available.map((candidate) => (
                        <option key={candidateKey(candidate)} value={candidateKey(candidate)}>
                          {node.nodeType === 'qq'
                            ? `QQ ${candidate.displayName}`
                            : `Discord ${candidate.displayName}`}
                        </option>
                      ))}
                    </select>
                  </label>
                  {!available.length && (
                    <small>没有新的可绑定会话，请确认客户端已加入目标会话后刷新。</small>
                  )}
                  <div className="binding-actions">
                    <button
                      className="primary"
                      disabled={!node.online || !available.length}
                      onClick={() => void configure(node)}
                    >
                      发送验证码
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

function candidateKey(candidate: SessionCandidate): string {
  return `${candidate.spaceId}\u001f${candidate.externalId}`;
}

function LlmSettings() {
  const settings = useLoad<Record<string, unknown>>('/settings/llm', {});
  const [form, setForm] = useState({
    baseUrl: '',
    apiKey: '',
    translationModel: '',
    moderationModel: '',
    timeoutMs: 30000,
    maxRetries: 2,
    concurrency: 4,
  });
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (Object.keys(settings.data).length)
      setForm((current) => ({ ...current, ...settings.data, apiKey: '' }));
  }, [settings.data]);
  const save = async () => {
    try {
      await api('/settings/llm', {
        method: 'PUT',
        json: { ...form, ...(form.apiKey ? {} : { apiKey: undefined }) },
      });
      setNotice('设置已保存，API 密钥不会回传到浏览器。');
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : '保存失败');
    }
  };
  if (settings.loading) return <LoadingState text="正在读取模型设置" />;
  return (
    <div className="panel form-panel">
      <PanelTitle
        title="大模型 API"
        subtitle="兼容 OpenAI Chat Completions 接口；翻译与审核可使用不同模型"
      />
      <div className="form-grid">
        <label className="wide">
          API 基础地址
          <input
            value={form.baseUrl}
            placeholder="https://api.example.com/v1"
            onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
          />
        </label>
        <label className="wide">
          API 密钥
          <input
            type="password"
            value={form.apiKey}
            placeholder={settings.data.apiKeyConfigured ? '已保存；留空表示不修改' : 'sk-…'}
            onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
          />
        </label>
        <label>
          翻译模型
          <input
            value={form.translationModel}
            onChange={(event) => setForm({ ...form, translationModel: event.target.value })}
          />
        </label>
        <label>
          审核模型
          <input
            value={form.moderationModel}
            onChange={(event) => setForm({ ...form, moderationModel: event.target.value })}
          />
        </label>
        <label>
          超时（毫秒）
          <input
            type="number"
            value={form.timeoutMs}
            onChange={(event) => setForm({ ...form, timeoutMs: Number(event.target.value) })}
          />
        </label>
        <label>
          并发数
          <input
            type="number"
            value={form.concurrency}
            onChange={(event) => setForm({ ...form, concurrency: Number(event.target.value) })}
          />
        </label>
      </div>
      <div className="safety-note">
        <ShieldCheck size={17} />
        <span>这里只配置模型连接；翻译、审核提示词与审核阈值均在蓝图模块内设置。</span>
      </div>
      {notice && <div className="notice">{notice}</div>}
      <button className="primary fit" onClick={() => void save()}>
        <Save size={16} />
        保存设置
      </button>
    </div>
  );
}

function Records({ kind }: { kind: 'reviews' | 'logs' }) {
  const records = useLoad<Array<Record<string, unknown>>>(`/${kind}`, []);
  const [logLevel, setLogLevel] = useState('all');
  const visibleRecords =
    kind === 'reviews'
      ? records.data.filter((record) => record.status === 'pending')
      : logLevel !== 'all'
        ? records.data.filter((record) => String(record.level ?? 'info') === logLevel)
        : records.data;
  const decide = async (taskId: string, decision: 'approve' | 'reject') => {
    await api(`/reviews/${taskId}/decision`, { method: 'POST', json: { decision } });
    await records.reload();
  };
  const clearReviews = async () => {
    if (!window.confirm('确定清除全部人工审核记录吗？仍在等待的消息将不会继续转发。')) return;
    await api('/reviews', { method: 'DELETE' });
    await records.reload();
  };
  return (
    <div className="panel">
      <PanelTitle
        title={kind === 'reviews' ? '待审核消息' : '追踪日志'}
        subtitle={
          kind === 'reviews'
            ? '消息会停在人工审核节点；操作后从“通过”或“拦截”出口继续'
            : '按 traceId 追踪消息在中心的处理过程'
        }
        action={
          <div className="log-actions">
            {kind === 'logs' && (
              <select value={logLevel} onChange={(event) => setLogLevel(event.target.value)}>
                <option value="all">全部级别</option>
                <option value="debug">Debug</option>
                <option value="info">Info</option>
                <option value="warn">Warn</option>
                <option value="error">Error</option>
              </select>
            )}
            {kind === 'reviews' && (
              <button
                className="clear-button"
                disabled={!records.data.length}
                onClick={() => void clearReviews()}
              >
                <Trash2 size={15} />
                一键清除
              </button>
            )}
            <button className="icon-button" onClick={() => void records.reload()}>
              <RefreshCw size={16} />
            </button>
          </div>
        }
      />
      {records.loading && (
        <LoadingState text={kind === 'reviews' ? '正在读取待审核消息' : '正在读取运行日志'} />
      )}
      <div className="record-list">
        {visibleRecords.map((record, index) => (
          <div
            className={`record ${kind === 'logs' ? `log-${String(record.level ?? 'info')}` : ''}`}
            key={String(record.taskId ?? record.id ?? index)}
          >
            <div>
              <strong>{String(record.event ?? record.reason ?? '审核任务')}</strong>
              <span>{formatTime(String(record.createdAt ?? ''))}</span>
            </div>
            {kind === 'logs' && (
              <span className={`log-level ${String(record.level ?? 'info')}`}>
                {String(record.level ?? 'info').toUpperCase()}
              </span>
            )}
            <code>{String(record.traceId ?? record.taskId ?? '')}</code>
            {kind === 'reviews' && record.status === 'pending' && (
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
        {!records.loading && !visibleRecords.length && (
          <Empty text={kind === 'reviews' ? '目前没有待处理内容' : '暂无日志'} />
        )}
      </div>
    </div>
  );
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
function formatTime(value?: string) {
  if (!value) return '暂无记录';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString('zh-CN', { hour12: false });
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
