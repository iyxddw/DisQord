import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { FileTaskQueue, type QueueItem } from '@disqord/queue';
import { messageEnvelopeSchema, type MessageEnvelope } from '@disqord/shared';
import { AuthenticatedNodeClient, type NodeIdentity } from '@disqord/transport';
import { z } from 'zod';

import { NodeConfigStore } from './config.js';
import { NodeLogger, type NodeLogPage, type NodeLogQuery } from './logger.js';

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
  targetMessageId: z.string().min(1).optional(),
});

const nodeLogRequestSchema = z.object({
  requestId: z.uuid(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(10).max(200).default(50),
  level: z.enum(['all', 'warn', 'error']).default('all'),
  search: z.string().trim().max(200).default(''),
});

type DeliveryCommand = z.infer<typeof deliverCommandSchema>;

export interface NodeBridgeRuntimeOptions {
  readonly nodeType: NodeIdentity['nodeType'];
  readonly centralUrl: string;
  readonly configPath: string;
  readonly queuePath: string;
  readonly logPath?: string;
  readonly allowInsecureCentral?: boolean;
  readonly createAdapter: (identity: NodeIdentity) => PlatformAdapter;
  readonly onStatus?: (status: {
    readonly state: 'starting' | 'connected' | 'retrying' | 'stopped';
    readonly detail?: string;
  }) => void;
}

const MAX_DELIVERY_ATTEMPTS = 5;

export class NodeBridgeRuntime {
  readonly #options: NodeBridgeRuntimeOptions;
  readonly #configStore: NodeConfigStore;
  readonly #logger: NodeLogger;
  #queue: FileTaskQueue | undefined;
  #client: AuthenticatedNodeClient | undefined;
  #adapter: PlatformAdapter | undefined;
  #draining = false;
  #retryTimer: NodeJS.Timeout | undefined;
  readonly #deliveryChains = new Map<string, Promise<void>>();
  readonly #deliveryTasks = new Map<string, Promise<void>>();

  constructor(options: NodeBridgeRuntimeOptions) {
    this.#options = options;
    this.#configStore = new NodeConfigStore(options.configPath);
    this.#logger = new NodeLogger(options.logPath ?? `${options.queuePath}.log`);
  }

  async start(): Promise<void> {
    this.#options.onStatus?.({ state: 'starting' });
    this.#log('info', 'runtime_starting', {
      nodeType: this.#options.nodeType,
      centralUrl: this.#options.centralUrl,
      queuePath: this.#options.queuePath,
      logPath: this.#logger.path,
    });
    await mkdir(dirname(this.#options.queuePath), { recursive: true });
    this.#queue = new FileTaskQueue(this.#options.queuePath);
    const config = await this.#configStore.loadOrCreate(this.#options.nodeType);
    this.#adapter = this.#options.createAdapter(config.identity);
    let sessionToken = config.sessionToken;
    if (!sessionToken) {
      this.#log('info', 'pairing_started', { nodeId: config.identity.nodeId });
      sessionToken = await AuthenticatedNodeClient.pair({
        url: this.#options.centralUrl,
        identity: config.identity,
        ...(this.#options.allowInsecureCentral === undefined
          ? {}
          : { allowInsecure: this.#options.allowInsecureCentral }),
      });
      await this.#configStore.save({ identity: config.identity, sessionToken });
      this.#log('info', 'pairing_completed', { nodeId: config.identity.nodeId });
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
        this.#log('info', 'central_connected');
        void this.#announceSessions();
        void this.#drainQueue();
      },
      onCommand: async (command) => await this.#handleCommand(command.kind, command.payload),
    });

    await this.#adapter.start(async (message) => {
      const validated = messageEnvelopeSchema.parse(message);
      const queued = this.#queue?.enqueue({
        id: validated.eventId,
        kind: 'message.upload',
        payload: validated,
      });
      this.#log('info', 'message_queued', {
        eventId: validated.eventId,
        channelId: validated.source.channelId,
        messageId: validated.source.messageId,
        duplicate: queued === false,
      });
      await this.#drainQueue();
    });
    try {
      await this.#client.connect();
    } catch (error) {
      this.#setRetrying(error);
    }
  }

  async stop(): Promise<void> {
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    this.#client?.disconnect();
    await this.#adapter?.stop();
    this.#queue?.close();
    this.#queue = undefined;
    this.#log('info', 'runtime_stopped');
    this.#options.onStatus?.({ state: 'stopped' });
  }

  async refreshSessions(): Promise<void> {
    await this.#announceSessions();
  }

  listLogs(query: NodeLogQuery = {}): NodeLogPage {
    return this.#logger.list(query);
  }

  async #announceSessions(): Promise<void> {
    const candidates = await this.#adapter?.listSessions();
    if (!candidates) return;
    this.#log('debug', 'session_candidates_ready', { count: candidates.length });
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
      this.#log('info', 'verification_requested', { externalId: command.externalId });
      await this.#adapter.sendVerification(command.externalId, command.code, command.expiresAt);
      this.#log('info', 'verification_sent', { externalId: command.externalId });
      return;
    }
    if (kind === 'node.logs.request') {
      const request = nodeLogRequestSchema.parse(payload);
      const page = this.#logger.list({
        page: request.page,
        pageSize: request.pageSize,
        search: request.search,
        levels: request.level === 'all' ? ['warn', 'error'] : [request.level],
      });
      await this.#client?.send('node.logs.response', {
        requestId: request.requestId,
        page,
      });
      this.#log('debug', 'node_logs_sent', {
        requestId: request.requestId,
        page: page.page,
        count: page.items.length,
      });
      return;
    }
    if (kind === 'message.deliver') {
      const command = deliverCommandSchema.parse(payload);
      this.#log('info', 'delivery_queued', {
        taskId: command.taskId,
        targetSessionId: command.targetSessionId,
        externalId: command.externalId,
        cardCount: command.cards.length,
      });
      await this.#scheduleDelivery(command.taskId, command);
    }
  }

  async #scheduleDelivery(taskId: string, command?: DeliveryCommand): Promise<void> {
    const existing = this.#deliveryTasks.get(taskId);
    if (existing) return await existing;
    if (!this.#queue) throw new Error('Node queue is not ready.');
    if (!this.#queue.get(taskId)) {
      if (!command) throw new Error(`Delivery queue item ${taskId} is missing.`);
      this.#queue.enqueue({ id: taskId, kind: 'message.deliver', payload: command });
    }
    const queued = this.#queue.get<DeliveryCommand>(taskId);
    if (!queued) throw new Error(`Delivery queue item ${taskId} is missing.`);
    const key = queued.payload.targetSessionId;
    const previous = this.#deliveryChains.get(key) ?? Promise.resolve();
    const task = previous
      .catch(() => undefined)
      .then(async () => await this.#processDelivery(queued.id));
    this.#deliveryTasks.set(taskId, task);
    this.#deliveryChains.set(key, task);
    try {
      await task;
    } finally {
      if (this.#deliveryTasks.get(taskId) === task) this.#deliveryTasks.delete(taskId);
      if (this.#deliveryChains.get(key) === task) this.#deliveryChains.delete(key);
    }
  }

  async #processDelivery(taskId: string): Promise<void> {
    const queue = this.#queue;
    if (!queue || !this.#client) throw new Error('Node delivery runtime is not ready.');
    let item = queue.get<DeliveryCommand>(taskId);
    if (!item) throw new Error(`Delivery queue item ${taskId} is missing.`);

    if (item.status === 'acknowledged' && item.payload.targetMessageId) {
      await this.#sendDelivered(item.payload);
      return;
    }
    if (item.status === 'dead_letter') throw new Error(`Delivery ${taskId} is in dead letter.`);

    for (;;) {
      item = queue.get<DeliveryCommand>(taskId);
      if (!item) throw new Error(`Delivery queue item ${taskId} disappeared.`);
      if (item.status === 'acknowledged' && item.payload.targetMessageId) {
        await this.#sendDelivered(item.payload);
        return;
      }
      if (item.status === 'processing') queue.markRetrying(taskId);
      queue.markProcessing(taskId);
      const attempt = queue.get(taskId)?.attempts ?? 1;
      this.#log('debug', 'delivery_attempt_started', {
        taskId,
        targetSessionId: item.payload.targetSessionId,
        attempt,
      });
      try {
        let firstMessageId: string | undefined;
        for (const [index, card] of item.payload.cards.entries()) {
          if (!this.#adapter) throw new Error('Platform adapter is not running.');
          const messageId = await this.#adapter.sendCard(
            item.payload.externalId,
            Buffer.from(card, 'base64'),
            index === 0 ? item.payload.replyMessageId : undefined,
          );
          firstMessageId ??= messageId;
        }
        if (!firstMessageId) throw new Error('The platform did not return a message ID.');
        const completed = { ...item.payload, targetMessageId: firstMessageId };
        queue.updatePayload(taskId, completed);
        queue.markAcknowledged(taskId);
        this.#log('info', 'delivery_platform_confirmed', {
          taskId,
          targetSessionId: item.payload.targetSessionId,
          targetMessageId: firstMessageId,
        });
        await this.#sendDelivered(completed);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const current = queue.get(taskId);
        if (!current || current.status === 'acknowledged') throw error;
        if (current.attempts >= MAX_DELIVERY_ATTEMPTS) {
          queue.markDeadLetter(taskId);
          this.#log('error', 'delivery_dead_letter', {
            taskId,
            attempts: current.attempts,
            error: message,
          });
          await this.#sendDeliveryFailed(item.payload, message);
          throw error;
        }
        queue.markRetrying(taskId);
        this.#log('warn', 'delivery_retry_scheduled', {
          taskId,
          attempts: current.attempts,
          nextDelayMs: retryDelay(current.attempts),
          error: message,
        });
        await delay(retryDelay(current.attempts));
      }
    }
  }

  async #sendDelivered(command: DeliveryCommand): Promise<void> {
    if (!command.targetMessageId) throw new Error('Missing target message ID.');
    await this.#client?.send('message.delivered', {
      taskId: command.taskId,
      sourceSessionId: command.sourceSessionId,
      sourceMessageId: command.sourceMessageId,
      targetSessionId: command.targetSessionId,
      targetMessageId: command.targetMessageId,
    });
    this.#log('info', 'delivery_acknowledged_by_central', { taskId: command.taskId });
  }

  async #sendDeliveryFailed(command: DeliveryCommand, error: string): Promise<void> {
    try {
      await this.#client?.send('message.delivery_failed', {
        taskId: command.taskId,
        sourceSessionId: command.sourceSessionId,
        sourceMessageId: command.sourceMessageId,
        targetSessionId: command.targetSessionId,
        error,
      });
    } catch (cause) {
      this.#log('error', 'delivery_failure_report_failed', {
        taskId: command.taskId,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  async #drainQueue(): Promise<void> {
    if (this.#draining || !this.#queue || !this.#client) return;
    this.#draining = true;
    try {
      for (const item of this.#queue.listRecoverable(100)) {
        if (item.kind === 'message.upload') {
          const completed = await this.#processUpload(item as QueueItem<MessageEnvelope>);
          if (!completed) break;
        } else if (item.kind === 'message.deliver') {
          void this.#scheduleDelivery(item.id).catch((error: unknown) => {
            this.#log('error', 'delivery_recovery_failed', {
              taskId: item.id,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
      }
    } finally {
      this.#draining = false;
    }
  }

  async #processUpload(item: QueueItem<MessageEnvelope>): Promise<boolean> {
    if (!this.#queue || !this.#client) return false;
    try {
      if (item.status === 'processing') this.#queue.markRetrying(item.id);
      this.#queue.markProcessing(item.id);
      this.#log('debug', 'message_upload_attempt_started', {
        eventId: item.id,
        attempt: this.#queue.get(item.id)?.attempts ?? 1,
      });
      await this.#client.send(item.kind, item.payload);
      this.#queue.markAcknowledged(item.id);
      this.#log('info', 'message_upload_acknowledged', { eventId: item.id });
      return true;
    } catch (error) {
      const current = this.#queue.get(item.id);
      const message = error instanceof Error ? error.message : String(error);
      if (current?.status === 'processing') {
        if (current.attempts >= 10) {
          this.#queue.markDeadLetter(item.id);
          this.#log('error', 'message_upload_dead_letter', {
            eventId: item.id,
            attempts: current.attempts,
            error: message,
          });
        } else {
          this.#queue.markRetrying(item.id);
          this.#log('warn', 'message_upload_retry_scheduled', {
            eventId: item.id,
            attempts: current.attempts,
            error: message,
          });
          this.#scheduleDrain(retryDelay(current.attempts));
        }
      }
      this.#setRetrying(error);
      return false;
    }
  }

  #scheduleDrain(delayMs: number): void {
    if (this.#retryTimer) return;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      void this.#drainQueue();
    }, delayMs);
    this.#retryTimer.unref();
  }

  #setRetrying(error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.#options.onStatus?.({ state: 'retrying', detail });
    this.#log('warn', 'runtime_retrying', { error: detail });
  }

  #log(
    level: 'debug' | 'info' | 'warn' | 'error',
    event: string,
    details?: Record<string, unknown>,
  ): void {
    try {
      this.#logger.write(level, event, details);
    } catch {
      // Logging must never stop message delivery.
    }
  }
}

function retryDelay(attempt: number): number {
  return Math.min(16_000, 1_000 * 2 ** Math.max(0, attempt - 1));
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
