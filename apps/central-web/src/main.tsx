import { StrictMode, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
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
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import {
  Activity,
  Bot,
  Check,
  ChevronRight,
  CircleAlert,
  FileClock,
  Languages,
  LogOut,
  MessagesSquare,
  Network,
  Plus,
  RefreshCw,
  Save,
  Server,
  Settings,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';

import '@xyflow/react/dist/style.css';
import './styles.css';
import {
  api,
  type AuthStatus,
  type ChatSession,
  type NodeRuntime,
  type PromptPurpose,
  type PromptVersion,
} from './api';

type Page =
  'overview' | 'sessions' | 'blueprint' | 'nodes' | 'settings' | 'prompts' | 'reviews' | 'logs';

const navigation: Array<{ id: Page; label: string; icon: typeof Activity }> = [
  { id: 'overview', label: '运行概览', icon: Activity },
  { id: 'sessions', label: '聊天会话', icon: MessagesSquare },
  { id: 'blueprint', label: '转发蓝图', icon: Network },
  { id: 'nodes', label: '节点连接', icon: Server },
  { id: 'settings', label: '基础设置', icon: Settings },
  { id: 'prompts', label: '高级模式', icon: Sparkles },
  { id: 'reviews', label: '人工审核', icon: ShieldCheck },
  { id: 'logs', label: '运行日志', icon: FileClock },
];

function useLoad<T>(path: string, fallback: T) {
  const [data, setData] = useState<T>(fallback);
  const [error, setError] = useState('');
  const reload = useCallback(async () => {
    try {
      setData(await api<T>(path));
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '加载失败');
    }
  }, [path]);
  useEffect(() => void reload(), [reload]);
  return { data, error, reload, setData };
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
          <div className="brand-mark">
            <MessagesSquare size={21} />
          </div>
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
                className={page === item.id ? 'active' : ''}
                key={item.id}
                onClick={() => setPage(item.id)}
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
          <div>
            <p className="eyebrow">CONTROL PLANE</p>
            <h1>{current.label}</h1>
          </div>
          <div className="header-status">
            <ShieldCheck size={17} /> 管理连接已加密
          </div>
        </header>
        <section className="page">
          {page === 'overview' && <Overview />}
          {page === 'sessions' && <Sessions />}
          {page === 'blueprint' && <BlueprintEditor />}
          {page === 'nodes' && <Nodes />}
          {page === 'settings' && <LlmSettings />}
          {page === 'prompts' && <Prompts />}
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
      <div className="brand-mark">
        <MessagesSquare />
      </div>
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
      <div className="auth-copy">
        <p className="eyebrow">QQ ↔ DISCORD</p>
        <h1>
          让两边的对话，
          <br />
          在这里安全汇合。
        </h1>
        <p>三端隔离架构、AI 双语翻译与审核、统一图片渲染。</p>
      </div>
      <div className="auth-card">
        <div className="brand-mark">
          <MessagesSquare size={22} />
        </div>
        <h2>{configured ? '欢迎回来' : '创建管理员'}</h2>
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
  return (
    <>
      <div className="hero-card">
        <div>
          <span className="live">
            <i />
            系统运行中
          </span>
          <h2>消息桥接状态良好</h2>
          <p>中心服务正在接收节点心跳，并按已发布蓝图处理消息。</p>
        </div>
        <div className="orb">
          <Network size={38} />
        </div>
      </div>
      <div className="stats">
        <Stat label="在线节点" value={`${online} / 2`} icon={Server} />
        <Stat
          label="已验证会话"
          value={String(sessions.data.filter((item) => item.status === 'verified').length)}
          icon={MessagesSquare}
        />
        <Stat label="待人工审核" value={String(reviews.data.length)} icon={ShieldCheck} />
      </div>
      <div className="panel">
        <PanelTitle title="节点近况" subtitle="QQ 与 Discord 分别运行在独立服务器" />
        <div className="node-grid">
          {(['qq', 'discord'] as const).map((type) => {
            const node = nodes.data.find((item) => item.nodeType === type);
            return (
              <div className="node-card" key={type}>
                <div className={`platform ${type}`}>
                  <Bot size={20} />
                </div>
                <div>
                  <strong>{type === 'qq' ? 'QQ / NapCat' : 'Discord Bot'}</strong>
                  <span>
                    {node
                      ? node.online
                        ? '安全通道在线'
                        : `最后活动 ${formatTime(node.lastSeenAt)}`
                      : '等待节点首次连接'}
                  </span>
                </div>
                <b className={node?.online ? 'ok' : 'muted'}>
                  {node?.online ? '在线' : node ? '已配对' : '未连接'}
                </b>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

function Stat({ label, value, icon: Icon }: { label: string; value: string; icon: typeof Server }) {
  return (
    <div className="stat">
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
      <Icon size={22} />
    </div>
  );
}

function Sessions() {
  const { data, reload, error } = useLoad<ChatSession[]>('/chat-sessions', []);
  const nodes = useLoad<NodeRuntime[]>('/nodes', []);
  const candidates = useLoad<
    Array<{
      nodeId: string;
      platform: 'qq' | 'discord';
      externalId: string;
      spaceId: string;
      displayName: string;
    }>
  >('/chat-sessions/candidates', []);
  const [form, setForm] = useState({
    nodeId: '',
    platform: 'qq',
    externalId: '',
    spaceId: '',
    displayName: '',
  });
  const [verify, setVerify] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  const add = async () => {
    try {
      const session = await api<ChatSession>('/chat-sessions', { method: 'POST', json: form });
      await api(`/chat-sessions/${session.id}/send-code`, { method: 'POST' });
      setNotice('验证码已发送到目标会话，请在下方回填。');
      await reload();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : '添加失败');
    }
  };
  return (
    <div className="split">
      <div className="panel">
        <PanelTitle
          title="已配置会话"
          subtitle="只有完成验证码确认的会话可用于蓝图"
          action={
            <button className="icon-button" onClick={() => void reload()}>
              <RefreshCw size={16} />
            </button>
          }
        />
        {error && <div className="error">{error}</div>}
        <div className="list">
          {data.map((session) => (
            <div className="session-row" key={session.id}>
              <div className={`platform ${session.platform}`}>
                <MessagesSquare size={18} />
              </div>
              <div className="grow">
                <strong>{session.displayName}</strong>
                <span>
                  {session.platform.toUpperCase()} · {session.externalId}
                </span>
              </div>
              {session.status === 'verified' ? (
                <span className="badge success">
                  <Check size={13} />
                  已验证
                </span>
              ) : (
                <div className="verify-box">
                  <input
                    placeholder="回填验证码"
                    value={verify[session.id] ?? ''}
                    onChange={(event) => setVerify({ ...verify, [session.id]: event.target.value })}
                  />
                  <button
                    onClick={() =>
                      void api(`/chat-sessions/${session.id}/verify`, {
                        method: 'POST',
                        json: { code: verify[session.id] },
                      }).then(reload)
                    }
                  >
                    验证
                  </button>
                </div>
              )}
            </div>
          ))}
          {!data.length && <Empty text="还没有聊天会话" />}
        </div>
      </div>
      <div className="panel compact">
        <PanelTitle title="添加会话" subtitle="保存后会立即向目标发送验证码" />
        <label>
          自动发现
          <select
            value=""
            onChange={(event) => {
              const candidate = candidates.data[Number(event.target.value)];
              if (candidate) setForm(candidate);
            }}
          >
            <option value="">从节点发现的会话中选择</option>
            {candidates.data.map((candidate, index) => (
              <option key={`${candidate.nodeId}:${candidate.externalId}`} value={index}>
                {candidate.platform.toUpperCase()} · {candidate.displayName}
              </option>
            ))}
          </select>
        </label>
        <label>
          所属节点
          <select
            value={form.nodeId}
            onChange={(event) => {
              const node = nodes.data.find((item) => item.nodeId === event.target.value);
              setForm({ ...form, nodeId: event.target.value, platform: node?.nodeType ?? 'qq' });
            }}
          >
            <option value="">选择已连接节点</option>
            {nodes.data.map((node) => (
              <option key={node.nodeId} value={node.nodeId}>
                {node.nodeType.toUpperCase()} · {node.nodeId.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
        <label>
          会话名称
          <input
            value={form.displayName}
            onChange={(event) => setForm({ ...form, displayName: event.target.value })}
            placeholder="例如：产品交流 / general"
          />
        </label>
        <label>
          群号或频道 ID
          <input
            value={form.externalId}
            onChange={(event) =>
              setForm({ ...form, externalId: event.target.value, spaceId: event.target.value })
            }
          />
        </label>
        {form.platform === 'discord' && (
          <label>
            服务器 ID
            <input
              value={form.spaceId}
              onChange={(event) => setForm({ ...form, spaceId: event.target.value })}
            />
          </label>
        )}
        {notice && <div className="notice">{notice}</div>}
        <button className="primary" onClick={() => void add()}>
          <Plus size={16} />
          保存并发送验证码
        </button>
      </div>
    </div>
  );
}

type FlowData = { label: string; sessionId: string; kind: 'input' | 'output' };
function FlowNode({ data }: NodeProps<Node<FlowData>>) {
  return (
    <div className={`flow-node ${data.kind}`}>
      <Handle
        type={data.kind === 'input' ? 'source' : 'target'}
        position={data.kind === 'input' ? Position.Right : Position.Left}
      />
      <span>{data.kind === 'input' ? '消息来源' : '转发目标'}</span>
      <strong>{data.label}</strong>
    </div>
  );
}

function BlueprintEditor() {
  const sessions = useLoad<ChatSession[]>('/chat-sessions', []);
  const usable = sessions.data.filter((item) => item.status === 'verified');
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<FlowData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [name, setName] = useState('双向翻译');
  const [selected, setSelected] = useState('');
  const [notice, setNotice] = useState('');
  const nodeTypes = useMemo(() => ({ session: FlowNode }), []);
  const addNode = (kind: FlowData['kind']) => {
    const session = usable.find((item) => item.id === selected);
    if (!session) return;
    setNodes((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        type: 'session',
        position: { x: kind === 'input' ? 80 : 520, y: 80 + current.length * 82 },
        data: { label: session.displayName, sessionId: session.id, kind },
      },
    ]);
  };
  const save = async () => {
    try {
      const graph = {
        name,
        nodes: nodes.map((node) => ({
          id: node.id,
          type: node.data.kind === 'input' ? 'chat-input' : 'chat-output',
          position: node.position,
          config: { sessionId: node.data.sessionId },
        })),
        edges: edges.map((edge) => ({
          id: edge.id,
          sourceNodeId: edge.source,
          targetNodeId: edge.target,
        })),
      };
      const version = await api<{ blueprintId: string; version: number }>('/blueprints', {
        method: 'POST',
        json: graph,
      });
      await api(`/blueprints/${version.blueprintId}/versions/${version.version}/publish`, {
        method: 'POST',
      });
      setNotice('蓝图已校验并发布，新的消息会立即使用此规则。');
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : '发布失败');
    }
  };
  return (
    <div className="blueprint-layout">
      <div className="flow-toolbar">
        <label>
          蓝图名称
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          选择会话
          <select value={selected} onChange={(event) => setSelected(event.target.value)}>
            <option value="">请选择</option>
            {usable.map((session) => (
              <option key={session.id} value={session.id}>
                {session.displayName}
              </option>
            ))}
          </select>
        </label>
        <div className="button-pair">
          <button onClick={() => addNode('input')}>
            <Plus size={15} />
            来源
          </button>
          <button onClick={() => addNode('output')}>
            <Plus size={15} />
            目标
          </button>
        </div>
        <button className="primary" onClick={() => void save()}>
          <Save size={16} />
          保存并发布
        </button>
        {notice && <p className="toolbar-notice">{notice}</p>}
        <div className="tip">
          <Network size={18} />
          <p>
            <strong>连线方法</strong>
            <br />
            从“消息来源”右侧圆点拖到“转发目标”左侧圆点。创建反向连线即可双向互通。
          </p>
        </div>
      </div>
      <div className="flow-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={(connection: Connection) => setEdges((items) => addEdge(connection, items))}
          nodeTypes={nodeTypes}
          fitView
        >
          <Background color="#263049" gap={24} />
          <MiniMap pannable zoomable />
          <Controls />
        </ReactFlow>
      </div>
    </div>
  );
}

function Nodes() {
  const nodes = useLoad<NodeRuntime[]>('/nodes', []);
  const [codes, setCodes] = useState<Record<string, { code: string; expiresAt: string }>>({});
  const createCode = async (nodeType: 'qq' | 'discord') => {
    const result = await api<{ code: string; expiresAt: string; nodeType: string }>(
      '/nodes/pairing-code',
      { method: 'POST', json: { nodeType } },
    );
    setCodes({ ...codes, [nodeType]: result });
  };
  return (
    <div className="node-columns">
      {(['qq', 'discord'] as const).map((type) => {
        const node = nodes.data.find((item) => item.nodeType === type);
        const code = codes[type];
        return (
          <div className="panel node-setup" key={type}>
            <div className={`platform large ${type}`}>
              <Bot size={25} />
            </div>
            <h2>{type === 'qq' ? 'QQ 节点' : 'Discord 节点'}</h2>
            <p>{type === 'qq' ? '连接 NapCat OneBot 11' : '连接 Discord Bot Gateway'}</p>
            <div className="connection-state">
              <i className={node?.online ? 'online' : ''} />
              {node
                ? `${node.online ? '在线' : '已配对'} · ${node.nodeId.slice(0, 12)}`
                : '尚未配对'}
            </div>
            {code ? (
              <div className="pair-code">
                <span>一次性配对码</span>
                <strong>{code.code}</strong>
                <small>{formatTime(code.expiresAt)} 前有效</small>
              </div>
            ) : (
              <button className="primary" onClick={() => void createCode(type)}>
                生成配对码
              </button>
            )}
            <p className="help">
              将配对码临时填入该节点的 <code>NODE_PAIRING_CODE</code>，启动成功后即可删除。
            </p>
          </div>
        );
      })}
    </div>
  );
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
    moderationSupportsVision: false,
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
      <label className="switch">
        <input
          type="checkbox"
          checked={form.moderationSupportsVision}
          onChange={(event) => setForm({ ...form, moderationSupportsVision: event.target.checked })}
        />
        <span />
        审核模型支持图片理解
      </label>
      {notice && <div className="notice">{notice}</div>}
      <button className="primary fit" onClick={() => void save()}>
        <Save size={16} />
        保存设置
      </button>
    </div>
  );
}

const promptLabels: Record<PromptPurpose, string> = {
  'translation-system': '翻译系统提示词',
  'translation-task': '翻译任务模板',
  'moderation-system': '审核系统提示词',
  'moderation-rules': '审核规则',
};
function Prompts() {
  const [purpose, setPurpose] = useState<PromptPurpose>('translation-system');
  const versions = useLoad<PromptVersion[]>(`/prompts/${purpose}`, []);
  const published = versions.data.find((item) => item.status === 'published');
  const [content, setContent] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => setContent(published?.content ?? ''), [published?.id]);
  const publish = async () => {
    try {
      const draft = await api<PromptVersion>(`/prompts/${purpose}/drafts`, {
        method: 'POST',
        json: { content },
      });
      await api(`/prompts/${purpose}/${draft.id}/publish`, { method: 'POST' });
      setNotice(`版本 ${draft.version} 已发布。`);
      await versions.reload();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : '发布失败');
    }
  };
  return (
    <div className="prompt-layout">
      <div className="prompt-tabs">
        {(Object.keys(promptLabels) as PromptPurpose[]).map((item) => (
          <button
            className={item === purpose ? 'active' : ''}
            onClick={() => setPurpose(item)}
            key={item}
          >
            <Languages size={17} />
            {promptLabels[item]}
            <span>{versions.data.filter((version) => version.purpose === item).length || ''}</span>
          </button>
        ))}
      </div>
      <div className="panel editor-panel">
        <PanelTitle
          title={promptLabels[purpose]}
          subtitle={`当前发布版本：${published ? `v${published.version}` : '无'}`}
        />
        <div className="safety-note">
          <ShieldCheck size={17} />
          <span>系统固定安全边界不会被此处内容覆盖；用户消息始终作为不可信数据传入。</span>
        </div>
        <textarea
          value={content}
          onChange={(event) => setContent(event.target.value)}
          spellCheck={false}
        />
        {notice && <div className="notice">{notice}</div>}
        <button className="primary fit" onClick={() => void publish()}>
          <Save size={16} />
          创建并发布新版本
        </button>
      </div>
    </div>
  );
}

function Records({ kind }: { kind: 'reviews' | 'logs' }) {
  const records = useLoad<Array<Record<string, unknown>>>(`/${kind}`, []);
  const decide = async (taskId: string, decision: 'approve' | 'reject') => {
    await api(`/reviews/${taskId}/decision`, { method: 'POST', json: { decision } });
    await records.reload();
  };
  return (
    <div className="panel">
      <PanelTitle
        title={kind === 'reviews' ? '待审核消息' : '追踪日志'}
        subtitle={
          kind === 'reviews'
            ? '大模型不确定或图片能力不足的消息会停在这里'
            : '按 traceId 追踪消息在中心的处理过程'
        }
        action={
          <button className="icon-button" onClick={() => void records.reload()}>
            <RefreshCw size={16} />
          </button>
        }
      />
      <div className="record-list">
        {records.data.map((record, index) => (
          <div className="record" key={String(record.taskId ?? record.id ?? index)}>
            <div>
              <strong>{String(record.event ?? record.reason ?? '审核任务')}</strong>
              <span>{formatTime(String(record.createdAt ?? ''))}</span>
            </div>
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
        {!records.data.length && (
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
      <Sparkles size={20} />
      <span>{text}</span>
    </div>
  );
}
function formatTime(value?: string) {
  if (!value) return '暂无记录';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

const root = document.querySelector('#root');
if (!root) throw new Error('Missing #root element');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
