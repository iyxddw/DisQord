import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  Bot,
  CheckCircle2,
  CircleAlert,
  Clock3,
  KeyRound,
  Link2,
  RefreshCw,
  Server,
} from 'lucide-react';

import './styles.css';

interface Status {
  program: 'qq-node' | 'discord-node';
  state: 'starting' | 'connected' | 'retrying' | 'stopped';
  detail?: string;
  centralUrl: string;
  platformConnected: boolean;
  startedAt: string;
}

function App() {
  const [status, setStatus] = useState<Status>();
  const [error, setError] = useState('');
  const [token, setToken] = useState(sessionStorage.getItem('node-token') ?? '');
  const load = async () => {
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
    }
  };
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [token]);
  const saveToken = (value: string) => {
    setToken(value);
    sessionStorage.setItem('node-token', value);
  };
  const refresh = async () => {
    await fetch('/api/node/refresh', {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    await load();
  };

  return (
    <main>
      <header>
        <div className="brand">
          <span>
            <Link2 />
          </span>
          <div>
            <strong>DisQord</strong>
            <small>节点控制面板</small>
          </div>
        </div>
        <div className={`state ${status?.state === 'connected' ? 'online' : ''}`}>
          <i />
          {stateLabel(status?.state)}
        </div>
      </header>
      <section className="hero">
        <div>
          <p className="eyebrow">
            {status?.program === 'discord-node' ? 'DISCORD NODE' : 'QQ / NAPCAT NODE'}
          </p>
          <h1>{status?.program === 'discord-node' ? 'Discord 消息节点' : 'QQ 消息节点'}</h1>
          <p>平台凭据和消息队列只保存在这台服务器。中央服务负责翻译、审核和渲染。</p>
        </div>
        <div className="hero-icon">
          <Bot size={38} />
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
      <section className="grid">
        <Card
          icon={Server}
          title="中央服务"
          value={status?.centralUrl ?? '等待配置'}
          hint="节点主动向中央建立 WSS 连接"
        />
        <Card
          icon={Activity}
          title="平台连接"
          value={status?.platformConnected ? '已连接' : '未连接'}
          hint={status?.program === 'discord-node' ? 'Discord Gateway' : 'NapCat OneBot WebSocket'}
        />
        <Card
          icon={Clock3}
          title="启动时间"
          value={
            status ? new Date(status.startedAt).toLocaleString('zh-CN', { hour12: false }) : '—'
          }
          hint="页面每 5 秒自动刷新"
        />
      </section>
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>连接诊断</h2>
            <p>这里不会显示机器人 Token、配对密钥或消息正文。</p>
          </div>
          <button onClick={() => void refresh()}>
            <RefreshCw size={16} />
            刷新会话列表
          </button>
        </div>
        <div className="checks">
          <Check label="节点程序已启动" ok={Boolean(status)} />
          <Check label="平台适配器已连接" ok={Boolean(status?.platformConnected)} />
          <Check label="中央安全通道已认证" ok={status?.state === 'connected'} />
        </div>
        {status?.detail && <pre>{status.detail}</pre>}
      </section>
      <section className="panel token-panel">
        <div>
          <KeyRound size={19} />
          <div>
            <h2>面板访问令牌</h2>
            <p>仅当面板监听非本机地址时需要。</p>
          </div>
        </div>
        <input
          type="password"
          placeholder="NODE_WEB_TOKEN"
          value={token}
          onChange={(event) => saveToken(event.target.value)}
        />
      </section>
    </main>
  );
}

function Card({
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
    <div className="card">
      <Icon size={20} />
      <span>{title}</span>
      <strong>{value}</strong>
      <small>{hint}</small>
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

const root = document.querySelector('#root');
if (!root) throw new Error('Missing #root element');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
