export interface ApiRetryOptions {
  readonly attempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
}

export type ApiRequestInit = RequestInit & {
  json?: unknown;
  retry?: ApiRetryOptions;
};

export async function api<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
  const { json, retry, ...requestInit } = init;
  const method = String(requestInit.method ?? 'GET').toUpperCase();
  const retryOptions = retry ?? (method === 'GET' ? { attempts: 3 } : undefined);
  const attempts = Math.max(1, retryOptions?.attempts ?? 1);
  const baseDelayMs = retryOptions?.baseDelayMs ?? 250;
  const maxDelayMs = retryOptions?.maxDelayMs ?? 2_000;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`/api${path}`, {
        ...requestInit,
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
          ...(json === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...requestInit.headers,
        },
        ...(json === undefined ? {} : { body: JSON.stringify(json) }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (response.ok) return body as T;
      const error = new Error(body.error ?? `请求失败（${response.status}）`);
      if (attempt >= attempts || response.status < 500) throw error;
      lastError = error;
    } catch (cause) {
      lastError = cause instanceof Error ? cause : new Error('请求失败');
      if (attempt >= attempts) throw lastError;
    }
    await new Promise((resolve) =>
      window.setTimeout(resolve, Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1))),
    );
  }
  throw lastError ?? new Error('请求失败');
}

export async function apiRetry<T>(
  path: string,
  init: Omit<ApiRequestInit, 'retry'> = {},
  retry: ApiRetryOptions = {},
): Promise<T> {
  return await api<T>(path, { ...init, retry });
}

export interface AuthStatus {
  configured: boolean;
  authenticated: boolean;
}

export interface ChatSession {
  id: string;
  nodeId: string;
  platform: 'qq' | 'discord';
  externalId: string;
  spaceId: string;
  displayName: string;
  remark?: string;
  verificationExpiresAt?: string;
  status: 'pending' | 'verified' | 'disabled' | 'stale';
}

export interface SessionCandidate {
  nodeId: string;
  platform: 'qq' | 'discord';
  externalId: string;
  spaceId: string;
  displayName: string;
}

export interface NodeRuntime {
  nodeId: string;
  nodeType: 'qq' | 'discord';
  verificationStatus?: 'pending' | 'verified';
  configuredSessions?: ChatSession[];
  lastFrameKind?: string;
  lastSeenAt?: string;
  online?: boolean;
  revoked?: boolean;
}

export interface BlueprintNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  config: Record<string, unknown>;
}

export interface BlueprintEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourceHandle?: string;
  targetHandle?: string;
}

export interface BlueprintVersion {
  id: string;
  blueprintId: string;
  version: number;
  status: 'draft' | 'published' | 'archived';
  nodes: BlueprintNode[];
  edges: BlueprintEdge[];
  createdAt: string;
  publishedAt?: string;
}

export interface Blueprint {
  id: string;
  name: string;
  enabled: boolean;
  activeVersion?: number;
  createdAt: string;
  updatedAt: string;
  versions: BlueprintVersion[];
}

export interface BlueprintActivity {
  id: string;
  blueprintId: string;
  version: number;
  traceId: string;
  nodeId: string;
  nodeType: string;
  phase?: 'entered' | 'completed' | 'failed';
  message: string;
  text?: string;
  violationScore?: number;
  route?: 'passed' | 'blocked';
  step: number;
  sequence: number;
  createdAt: string;
}

export interface BlueprintActivityPage {
  items: BlueprintActivity[];
  cursor: string;
}

export interface LogPage {
  items: Array<Record<string, unknown>>;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface PromptVersion {
  id: string;
  purpose: PromptPurpose;
  version: number;
  status: 'draft' | 'published' | 'archived';
  content: string;
}

export type PromptPurpose =
  'translation-system' | 'translation-task' | 'moderation-system' | 'moderation-rules';
