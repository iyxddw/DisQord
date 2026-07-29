import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { SqliteTaskQueue, type QueueItem } from '@disqord/queue';
import { messageEnvelopeSchema, type MessageEnvelope } from '@disqord/shared';
import { AuthenticatedNodeClient, type NodeIdentity } from '@disqord/transport';
import { z } from 'zod';

import { NodeConfigStore } from './config.js';

export interface PlatformSessionCandidate {
  readonly externalId: string;
  readonly spaceId: string;
  readonly displayName: string;
}

export interface PlatformAdapter {
  start(onMessage: (message: MessageEnvelope) => void | Promise<void>): Promise<void>;
  stop(): Promise<void>;
  listSessions(): Promise<readonly PlatformSessionCandidate[]>;
  sendVerification(externalId: string, code: string, expiresAt: string): Promise<string>;
  sendCard(externalId: string, png: Uint8Array, replyMessageId?: string): Promise<string>;
}

const verifyCommandSchema = z.object({
  externalId: z.string().min(1),
  code: z.string().min(4).max(32),
  expiresAt: z.iso.datetime({ offset: true }),
});

const deliverCommandSchema = z.object({
  taskId: z.uuid(),
  sourceSessionId: z.uuid(),
  sourceMessageId: z.string().min(1),
  targetSessionId: z.uuid(),
  externalId: z.string().min(1),
  cards: z.array(z.string().min(1)).min(1).max(20),
  replyMessageId: z.string().min(1).optional(),
});

export interface NodeBridgeRuntimeOptions {
  readonly nodeType: NodeIdentity['nodeType'];
  readonly centralUrl: string;
  readonly configPath: string;
  readonly queuePath: string;
  readonly allowInsecureCentral?: boolean;
  readonly createAdapter: (identity: NodeIdentity) => PlatformAdapter;
  readonly onStatus?: (status: {
    readonly state: 'starting' | 'connected' | 'retrying' | 'stopped';
    readonly detail?: string;
  }) => void;
}

export class NodeBridgeRuntime {
  readonly #options: NodeBridgeRuntimeOptions;
  readonly #configStore: NodeConfigStore;
  #queue: SqliteTaskQueue | undefined;
  #client: AuthenticatedNodeClient | undefined;
  #adapter: PlatformAdapter | undefined;
  #draining = false;

  constructor(options: NodeBridgeRuntimeOptions) {
    this.#options = options;
    this.#configStore = new NodeConfigStore(options.configPath);
  }

  async start(): Promise<void> {
    this.#options.onStatus?.({ state: 'starting' });
    await mkdir(dirname(this.#options.queuePath), { recursive: true });
    this.#queue = new SqliteTaskQueue(this.#options.queuePath);
    const config = await this.#configStore.loadOrCreate(this.#options.nodeType);
    this.#adapter = this.#options.createAdapter(config.identity);
    let sessionToken = config.sessionToken;
    if (!sessionToken) {
      sessionToken = await AuthenticatedNodeClient.pair({
        url: this.#options.centralUrl,
        identity: config.identity,
        ...(this.#options.allowInsecureCentral === undefined
          ? {}
          : { allowInsecure: this.#options.allowInsecureCentral }),
      });
      await this.#configStore.save({ identity: config.identity, sessionToken });
    }

    this.#client = new AuthenticatedNodeClient({
      url: this.#options.centralUrl,
      identity: config.identity,
      sessionToken,
      ...(this.#options.allowInsecureCentral === undefined
        ? {}
        : { allowInsecure: this.#options.allowInsecureCentral }),
      onConnected: () => {
        this.#options.onStatus?.({ state: 'connected' });
        void this.#announceSessions();
        void this.#drainQueue();
      },
      onCommand: async (command) => await this.#handleCommand(command.kind, command.payload),
    });

    await this.#adapter.start(async (message) => {
      const validated = messageEnvelopeSchema.parse(message);
      this.#queue?.enqueue({
        id: validated.eventId,
        kind: 'message.upload',
        payload: validated,
      });
      await this.#drainQueue();
    });
    try {
      await this.#client.connect();
    } catch (error) {
      this.#options.onStatus?.({
        state: 'retrying',
        detail:
          error instanceof Error
            ? error.message
            : 'Initial central connection failed; reconnecting.',
      });
    }
  }

  async stop(): Promise<void> {
    this.#client?.disconnect();
    await this.#adapter?.stop();
    this.#queue?.close();
    this.#queue = undefined;
    this.#options.onStatus?.({ state: 'stopped' });
  }

  async refreshSessions(): Promise<void> {
    await this.#announceSessions();
  }

  async #announceSessions(): Promise<void> {
    const candidates = await this.#adapter?.listSessions();
    if (!candidates) return;
    await this.#client?.send('session.candidates', { candidates });
  }

  async #handleCommand(kind: string, payload: unknown): Promise<void> {
    if (kind === 'session.discover') {
      await this.#announceSessions();
      return;
    }
    if (kind === 'session.verify') {
      const command = verifyCommandSchema.parse(payload);
      if (!this.#adapter) throw new Error('Platform adapter is not running.');
      await this.#adapter.sendVerification(command.externalId, command.code, command.expiresAt);
      return;
    }
    if (kind === 'message.deliver') {
      const command = deliverCommandSchema.parse(payload);
      let firstMessageId: string | undefined;
      for (const [index, card] of command.cards.entries()) {
        if (!this.#adapter) throw new Error('Platform adapter is not running.');
        const messageId = await this.#adapter.sendCard(
          command.externalId,
          Buffer.from(card, 'base64'),
          index === 0 ? command.replyMessageId : undefined,
        );
        firstMessageId ??= messageId;
      }
      if (!firstMessageId) throw new Error('The platform did not return a message ID.');
      await this.#client?.send('message.delivered', {
        taskId: command.taskId,
        sourceSessionId: command.sourceSessionId,
        sourceMessageId: command.sourceMessageId,
        targetSessionId: command.targetSessionId,
        targetMessageId: firstMessageId,
      });
    }
  }

  async #drainQueue(): Promise<void> {
    if (this.#draining || !this.#queue || !this.#client) return;
    this.#draining = true;
    try {
      for (const item of this.#queue.listRecoverable<MessageEnvelope>(100)) {
        await this.#processQueueItem(item);
      }
    } finally {
      this.#draining = false;
    }
  }

  async #processQueueItem(item: QueueItem<MessageEnvelope>): Promise<void> {
    if (!this.#queue || !this.#client) return;
    try {
      if (item.status === 'processing') this.#queue.markRetrying(item.id);
      this.#queue.markProcessing(item.id);
      await this.#client.send(item.kind, item.payload);
      this.#queue.markAcknowledged(item.id);
    } catch (error) {
      const current = this.#queue.get(item.id);
      if (current?.status === 'processing') {
        if (current.attempts >= 10) {
          this.#queue.markDeadLetter(item.id);
        } else {
          this.#queue.markRetrying(item.id);
        }
      }
      this.#options.onStatus?.({
        state: 'retrying',
        detail: error instanceof Error ? error.message : 'Queue delivery failed.',
      });
    }
  }
}
