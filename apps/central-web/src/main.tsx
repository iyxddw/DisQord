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
  useReactFlow,
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
  Power,
  RefreshCw,
  Save,
  Server,
  Settings,
  ShieldCheck,
  Sparkles,
  Trash2,
} from 'lucide-react';

import '@xyflow/react/dist/style.css';
import './styles.css';
import {
  api,
  type AuthStatus,
  type Blueprint,
  type BlueprintVersion,
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
  { id: 'nodes', label: '客户端列表', icon: Server },
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
  return (
    <div className="panel">
      <PanelTitle
        title="已配置聊天会话"
        subtitle="会话在客户端列表完成验证码验证后自动保存；只有已验证会话可用于蓝图"
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
                {session.platform === 'discord'
                  ? `服务器 ${session.spaceId} · 频道 ${session.externalId}`
                  : `群号 ${session.externalId}`}
              </span>
            </div>
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
        {!data.length && <Empty text="还没有聊天会话，请先到客户端列表完成验证" />}
      </div>
    </div>
  );
}

type FlowData = { label: string; sessionId: string; kind: 'input' | 'output' };
function FlowNode({ id, data }: NodeProps<Node<FlowData>>) {
  const { deleteElements } = useReactFlow();
  return (
    <div className={`flow-node ${data.kind}`}>
      <Handle
        type={data.kind === 'input' ? 'source' : 'target'}
        position={data.kind === 'input' ? Position.Right : Position.Left}
      />
      <span>{data.kind === 'input' ? '消息来源' : '转发目标'}</span>
      <strong>{data.label}</strong>
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
  const nodeTypes = useMemo(() => ({ session: FlowNode }), []);

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
      .filter((node) => node.type === 'chat-input' || node.type === 'chat-output')
      .map((node) => {
        const sessionId =
          typeof node.config.sessionId === 'string' ? node.config.sessionId : '未知会话';
        const session = sessions.data.find((item) => item.id === sessionId);
        return {
          id: node.id,
          type: 'session',
          position: node.position,
          data: {
            label: session?.displayName ?? sessionId,
            sessionId,
            kind: node.type === 'chat-input' ? ('input' as const) : ('output' as const),
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
      })),
    );
    setNotice(`已载入 ${blueprint.name} · v${version.version}`);
    setEditorKey((value) => value + 1);
  };

  const addNode = (kind: FlowData['kind']) => {
    const session = usable.find((item) => item.id === selected);
    if (!session) return;
    setNodes((current) => [
      ...current,
      {
        id: createBrowserId(),
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
          id: createBrowserId(),
          sourceNodeId: edge.source,
          targetNodeId: edge.target,
        })),
      };
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
          json: graph,
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
            从“消息来源”右侧圆点拖到“转发目标”左侧圆点。创建反向连线即可双向互通。
          </p>
        </div>
      </div>
      <div className="flow-canvas">
        <ReactFlow
          key={editorKey}
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={(connection: Connection) => setEdges((items) => addEdge(connection, items))}
          nodeTypes={nodeTypes}
          deleteKeyCode={['Backspace', 'Delete']}
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
  const sessions = useLoad<ChatSession[]>('/chat-sessions', []);
  const [drafts, setDrafts] = useState<Record<string, { spaceId: string; externalId: string }>>({});
  const [editing, setEditing] = useState<Record<string, boolean>>({});
  const [verificationCodes, setVerificationCodes] = useState<Record<string, string>>({});
  const [notices, setNotices] = useState<Record<string, string>>({});

  const updateDraft = (nodeId: string, patch: Partial<{ spaceId: string; externalId: string }>) => {
    setDrafts((current) => ({
      ...current,
      [nodeId]: { spaceId: '', externalId: '', ...current[nodeId], ...patch },
    }));
  };

  const configure = async (node: NodeRuntime) => {
    const draft = drafts[node.nodeId] ?? { spaceId: '', externalId: '' };
    const externalId = draft.externalId.trim();
    const spaceId = node.nodeType === 'qq' ? externalId : draft.spaceId.trim();
    try {
      const session = await api<ChatSession>('/chat-sessions', {
        method: 'POST',
        json: {
          nodeId: node.nodeId,
          platform: node.nodeType,
          externalId,
          spaceId,
          displayName:
            node.nodeType === 'qq' ? `QQ群 ${externalId}` : `Discord ${spaceId} / ${externalId}`,
        },
      });
      await api(`/chat-sessions/${session.id}/send-code`, { method: 'POST' });
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
      setEditing((current) => ({ ...current, [node.nodeId]: false }));
      setNotices((current) => ({ ...current, [node.nodeId]: '客户端与会话验证成功。' }));
      await Promise.all([sessions.reload(), nodes.reload()]);
    } catch (cause) {
      setNotices((current) => ({
        ...current,
        [node.nodeId]: cause instanceof Error ? cause.message : '验证码错误',
      }));
    }
  };

  return (
    <div className="node-columns">
      {nodes.data.map((node) => {
        const verified = sessions.data.find(
          (session) => session.nodeId === node.nodeId && session.status === 'verified',
        );
        const pending = sessions.data.find(
          (session) => session.nodeId === node.nodeId && session.status === 'pending',
        );
        const draft = drafts[node.nodeId] ?? { spaceId: '', externalId: '' };
        const showForm = !verified || editing[node.nodeId];
        return (
          <div className="panel node-setup" key={node.nodeId}>
            <div className={`platform large ${node.nodeType}`}>
              <Bot size={25} />
            </div>
            <h2>{node.nodeType === 'qq' ? 'QQ 客户端' : 'Discord 客户端'}</h2>
            <p>{node.nodeId}</p>
            <div className="connection-state">
              <i className={node.online ? 'online' : ''} />
              {node.online ? '在线' : '离线'} · {verified ? '已验证' : '等待验证'}
            </div>

            {verified && !showForm && (
              <div className="pair-code">
                <span>当前固定会话</span>
                <strong>{verified.displayName}</strong>
                <small>
                  {node.nodeType === 'discord'
                    ? `服务器 ${verified.spaceId} · 频道 ${verified.externalId}`
                    : `群号 ${verified.externalId}`}
                </small>
                <button onClick={() => setEditing({ ...editing, [node.nodeId]: true })}>
                  更改会话
                </button>
              </div>
            )}

            {showForm && (
              <>
                {node.nodeType === 'discord' && (
                  <label>
                    Discord 服务器 ID
                    <input
                      value={draft.spaceId}
                      onChange={(event) =>
                        updateDraft(node.nodeId, { spaceId: event.target.value })
                      }
                      placeholder="例如 123456789012345678"
                    />
                  </label>
                )}
                <label>
                  {node.nodeType === 'discord' ? 'Discord 频道 ID' : 'QQ群号'}
                  <input
                    value={draft.externalId}
                    onChange={(event) =>
                      updateDraft(node.nodeId, { externalId: event.target.value })
                    }
                    placeholder={
                      node.nodeType === 'discord' ? '例如 123456789012345678' : '例如 123456789'
                    }
                  />
                </label>
                <button
                  className="primary"
                  disabled={!node.online}
                  onClick={() => void configure(node)}
                >
                  发送验证码
                </button>
              </>
            )}

            {pending && (
              <div className="verify-box">
                <input
                  placeholder="回填频道或群内的验证码"
                  value={verificationCodes[pending.id] ?? ''}
                  onChange={(event) =>
                    setVerificationCodes({
                      ...verificationCodes,
                      [pending.id]: event.target.value,
                    })
                  }
                />
                <button onClick={() => void verify(node, pending)}>完成验证</button>
              </div>
            )}
            {notices[node.nodeId] && <div className="notice">{notices[node.nodeId]}</div>}
          </div>
        );
      })}
      {!nodes.data.length && <Empty text="尚无客户端；启动 QQ 或 Discord 客户端后会自动出现" />}
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
    visionModel: '',
    unreviewableImagePolicy: 'block' as 'allow' | 'block' | 'block-notify',
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
          识图审核模型（可选）
          <input
            value={form.visionModel}
            placeholder="留空表示图片无法审核"
            onChange={(event) => setForm({ ...form, visionModel: event.target.value })}
          />
        </label>
        <label>
          图片无法审核时
          <select
            value={form.unreviewableImagePolicy}
            onChange={(event) =>
              setForm({
                ...form,
                unreviewableImagePolicy: event.target.value as 'allow' | 'block' | 'block-notify',
              })
            }
          >
            <option value="block">拦截（不发送任何内容）</option>
            <option value="block-notify">拦截并保留占位消息</option>
            <option value="allow">直接通过</option>
          </select>
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
        <span>
          纯文字使用审核模型；含图片时使用识图审核模型。未配置识图模型或图片地址不可用时，按“图片无法审核时”的策略处理。
        </span>
      </div>
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
