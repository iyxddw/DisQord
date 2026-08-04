import { randomUUID } from 'node:crypto';

import { WebSocket } from 'ws';
import { z } from 'zod';

import {
  normalizeNapCatGroupMessage,
  napCatGroupMessageEventSchema,
  type NapCatReplyPreview,
} from './normalize.js';

const actionResponseSchema = z.object({
  status: z.string(),
  retcode: z.number(),
  data: z.unknown().optional(),
  echo: z.string(),
  message: z.string().optional(),
});

const groupListSchema = z.array(
  z.object({
    group_id: z.union([z.string(), z.number()]),
    group_name: z.string(),
    member_count: z.number().optional(),
    max_member_count: z.number().optional(),
  }),
);
const groupMemberInfoSchema = z.object({
  user_id: z.union([z.string(), z.number()]),
  nickname: z.string().optional(),
  card: z.string().optional(),
});
const replyMessageSchema = z.object({
  sender: z
    .object({
      user_id: z.union([z.string(), z.number()]).optional(),
      nickname: z.string().optional(),
      card: z.string().optional(),
    })
    .optional(),
  message: z
    .array(
      z.object({
        type: z.string(),
        data: z.record(z.string(), z.unknown()).default({}),
      }),
    )
    .optional(),
});

interface PendingAction {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export interface NapCatClientOptions {
  readonly url: string;
  readonly accessToken?: string;
  readonly nodeId: string;
  readonly onMessage: (
    message: NonNullable<ReturnType<typeof normalizeNapCatGroupMessage>>,
  ) => void | Promise<void>;
}

export interface NapCatGroup {
  readonly id: string;
  readonly name: string;
  readonly memberCount?: number;
  readonly maxMemberCount?: number;
}

export class NapCatOneBotClient {
  readonly #options: NapCatClientOptions;
  readonly #pending = new Map<string, PendingAction>();
  readonly #memberNameCache = new Map<string, { name: string; expiresAt: number }>();
  #socket: WebSocket | undefined;
  #manualClose = false;
  #reconnectTimer: NodeJS.Timeout | undefined;

  constructor(options: NapCatClientOptions) {
    const protocol = new URL(options.url).protocol;
    if (protocol !== 'ws:' && protocol !== 'wss:') {
      throw new Error('NapCat OneBot URL must use ws:// or wss://.');
    }
    this.#options = options;
  }

  async connect(): Promise<void> {
    if (this.#socket?.readyState === WebSocket.OPEN) return;
    this.#manualClose = false;
    const headers = this.#options.accessToken
      ? { Authorization: `Bearer ${this.#options.accessToken}` }
      : undefined;
    const socket = new WebSocket(this.#options.url, { headers });
    this.#socket = socket;

    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.on('message', (data) => {
      void this.#handleIncoming(data.toString()).catch(() => {
        // Malformed OneBot events are ignored and should be reported by the node logger.
      });
    });
    socket.on('close', () => {
      if (this.#socket === socket) this.#socket = undefined;
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('NapCat connection closed.'));
      }
      this.#pending.clear();
      this.#scheduleReconnect();
    });
  }

  disconnect(): void {
    this.#manualClose = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#socket?.close(1000, 'QQ node disconnect');
    this.#socket = undefined;
  }

  #scheduleReconnect(): void {
    if (this.#manualClose || this.#reconnectTimer) return;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      void this.connect().catch(() => this.#scheduleReconnect());
    }, 3_000);
    this.#reconnectTimer.unref();
  }

  async listGroups(): Promise<NapCatGroup[]> {
    const data = groupListSchema.parse(await this.call('get_group_list', {}));
    return data.map((group) => ({
      id: String(group.group_id),
      name: group.group_name,
      ...(group.member_count === undefined ? {} : { memberCount: group.member_count }),
      ...(group.max_member_count === undefined ? {} : { maxMemberCount: group.max_member_count }),
    }));
  }

  async sendGroupText(groupId: string, text: string, replyMessageId?: string): Promise<string> {
    const segments: Array<{ type: string; data: Record<string, unknown> }> = [];
    if (replyMessageId) segments.push({ type: 'reply', data: { id: replyMessageId } });
    segments.push({ type: 'text', data: { text } });
    return await this.#sendGroupSegments(groupId, segments);
  }

  async sendGroupImage(groupId: string, png: Uint8Array, replyMessageId?: string): Promise<string> {
    const message: Array<{ type: string; data: Record<string, unknown> }> = [];
    if (replyMessageId) {
      message.push({ type: 'reply', data: { id: replyMessageId } });
    }
    message.push({
      type: 'image',
      data: { file: `base64://${Buffer.from(png).toString('base64')}` },
    });
    return await this.#sendGroupSegments(groupId, message);
  }

  async call(action: string, params: Record<string, unknown>): Promise<unknown> {
    await this.connect();
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('NapCat connection is unavailable.');
    }
    const echo = randomUUID();
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(echo);
        reject(new Error(`NapCat action timed out: ${action}`));
      }, 15_000);
      timer.unref();
      this.#pending.set(echo, { resolve, reject, timer });
    });
    socket.send(JSON.stringify({ action, params, echo }));
    return await response;
  }

  async #sendGroupSegments(
    groupId: string,
    message: Array<{ type: string; data: Record<string, unknown> }>,
  ): Promise<string> {
    const response = z.object({ message_id: z.union([z.string(), z.number()]) }).parse(
      await this.call('send_group_msg', {
        group_id: groupId,
        message,
      }),
    );
    return String(response.message_id);
  }

  async #handleIncoming(text: string): Promise<void> {
    const raw = JSON.parse(text) as unknown;
    const response = actionResponseSchema.safeParse(raw);
    if (response.success) {
      const pending = this.#pending.get(response.data.echo);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(response.data.echo);
      if (response.data.status === 'ok' && response.data.retcode === 0) {
        pending.resolve(response.data.data);
      } else {
        pending.reject(
          new Error(response.data.message ?? `NapCat action failed: ${response.data.retcode}`),
        );
      }
      return;
    }

    const event = napCatGroupMessageEventSchema.safeParse(raw);
    if (event.success) {
      const [mentionNames, replyPreviews] = await Promise.all([
        this.#resolveMentionNames(event.data),
        this.#resolveReplyPreviews(event.data),
      ]);
      const message = normalizeNapCatGroupMessage(
        event.data,
        this.#options.nodeId,
        mentionNames,
        replyPreviews,
      );
      if (message) await this.#options.onMessage(message);
    }
  }

  async #resolveReplyPreviews(
    event: z.infer<typeof napCatGroupMessageEventSchema>,
  ): Promise<ReadonlyMap<string, NapCatReplyPreview>> {
    const replyIds = [
      ...new Set(
        event.message
          .filter((segment) => segment.type === 'reply')
          .map((segment) => String(segment.data.id ?? ''))
          .filter(Boolean),
      ),
    ];
    const previews = new Map<string, NapCatReplyPreview>();
    await Promise.all(
      replyIds.map(async (messageId) => {
        try {
          const replied = replyMessageSchema.parse(
            await this.call('get_msg', { message_id: messageId }),
          );
          const text = (replied.message ?? [])
            .filter((segment) => segment.type === 'text' || segment.type === 'at')
            .map((segment) =>
              segment.type === 'at'
                ? `@${String(segment.data.qq ?? '')}`
                : String(segment.data.text ?? ''),
            )
            .join('')
            .trim();
          const image = (replied.message ?? []).find(
            (segment) => segment.type === 'image' && typeof segment.data.url === 'string',
          );
          const fallbackSender = replied.sender?.user_id
            ? String(replied.sender.user_id)
            : '被回复用户';
          previews.set(messageId, {
            senderDisplayName:
              replied.sender?.card?.trim() || replied.sender?.nickname?.trim() || fallbackSender,
            ...(text ? { textPreview: text.slice(0, 1_000) } : {}),
            ...(typeof image?.data.url === 'string' ? { imageUrl: image.data.url } : {}),
          });
        } catch {
          // NapCat may no longer retain the referenced message; the renderer will
          // show an explicit unavailable-preview label instead of an empty box.
        }
      }),
    );
    return previews;
  }

  async #resolveMentionNames(
    event: z.infer<typeof napCatGroupMessageEventSchema>,
  ): Promise<ReadonlyMap<string, string>> {
    const groupId = String(event.group_id);
    const mentionedIds = [
      ...new Set(
        event.message
          .filter((segment) => segment.type === 'at')
          .map((segment) => String(segment.data.qq ?? ''))
          .filter((id) => id && id !== 'all'),
      ),
    ];
    const names = new Map<string, string>();
    await Promise.all(
      mentionedIds.map(async (userId) => {
        const cacheKey = `${groupId}:${userId}`;
        const cached = this.#memberNameCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
          names.set(userId, cached.name);
          return;
        }
        try {
          const member = groupMemberInfoSchema.parse(
            await this.call('get_group_member_info', {
              group_id: groupId,
              user_id: userId,
              no_cache: false,
            }),
          );
          const name = member.card?.trim() || member.nickname?.trim() || userId;
          names.set(userId, name);
          this.#memberNameCache.set(cacheKey, {
            name,
            expiresAt: Date.now() + 60 * 60 * 1_000,
          });
        } catch {
          // Keep the QQ number when NapCat cannot resolve this member.
        }
      }),
    );
    return names;
  }
}
