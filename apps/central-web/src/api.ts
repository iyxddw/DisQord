export async function api<T>(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      ...(init.json === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
    ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
  };
  if (!response.ok) throw new Error(body.error ?? `请求失败（${response.status}）`);
  return body as T;
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
  status: 'pending' | 'verified' | 'disabled' | 'stale';
}

export interface NodeRuntime {
  nodeId: string;
  nodeType: 'qq' | 'discord';
  verificationStatus?: 'pending' | 'verified';
  configuredSession?: ChatSession;
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

export interface PromptVersion {
  id: string;
  purpose: PromptPurpose;
  version: number;
  status: 'draft' | 'published' | 'archived';
  content: string;
}

export type PromptPurpose =
  'translation-system' | 'translation-task' | 'moderation-system' | 'moderation-rules';
