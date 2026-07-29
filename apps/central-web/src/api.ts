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
  lastFrameKind?: string;
  lastSeenAt?: string;
  online?: boolean;
  revoked?: boolean;
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
