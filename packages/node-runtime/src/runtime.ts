import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { FileTaskQueue, type QueueItem } from '@disqord/queue';
import { messageEnvelopeSchema, type MessageEnvelope } from '@disqord/shared';
import { AuthenticatedNodeClient, type NodeIdentity } from '@disqord/transport';
import { z } from 'zod';

import { NodeConfigStore } from './config.js';
import { NodeLogger, type NodeLogPage, type NodeLogQuery } from './logger.js';

const UPLOAD_BATCH_DELAYS_MS = [8_000, 6_000, 4_000, 2_000, 0] as const;
const MAX_UPLOAD_BATCH_SIZE = 25;
const DELIVERY_MIN_GAP_MS = 6_000;
const DELIVERY_MAX_GAP_MS = 13_000;
const FAST_DELIVERY_INTERVAL_MS = 5_000;
const FAST_UPLOAD_RETRY_DELAY_MS = 250;

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
  sendText(externalId: string, text: string, replyMessageId?: string): Promise<string>;
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
  mode: z.enum(['card', 'text']).default('card'),
  cards: z.array(z.string().min(1)).max(20).default([]),
  text: z.string().max(30_000).optional(),
  senderName: z.string().trim().min(1).max(256).optional(),
  fastMode: z.boolean().default(false),
  replyMessageId: z.string().min(1).optional(),
  targetMessageId: z.string().min(1).optional(),
}).superRefine((command, context) => {
  if (command.mode === 'card' && command.cards.length === 0) {
    context.addIssue({ code: 'custom', path: ['cards'], message: 'Card deliveries require at least one image.' });
  }
  if (command.mode === 'text' && !command.text?.trim()) {
    context.addIssue({ code: 'custom', path: ['text'], message: 'Text deliveries require text.' });
  }
});

const deliverBatchCommandSchema = z.object({
  batchId: z.uuid(),
  deliveries: z.array(deliverCommandSchema).min(1).max(25),
});

const nodeLogRequestSchema = z.object({
  requestId: z.uuid(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(10).max(200).default(50),
  level: z.enum(['all', 'warn', 'error']).default('all'),
  search: z.string().trim().max(200).default(''),
});
const runtimeSettingsSchema = z.object({
  fastMode: z.boolean().default(false),
  fastDeliveryIntervalMs: z.number().int().min(0).max(60_000).default(FAST_DELIVERY_INTERVAL_MS),
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
  #uploadBatchTimer: NodeJS.Timeout | undefined;
  #uploadBatchStage = 0;
  #fastMode = false;
  #fastDeliveryIntervalMs = FAST_DELIVERY_INTERVAL_MS;
  readonly #fastUploadTasks = new Map<string, Promise<boolean>>();
  readonly #deliveryChains = new Map<string, Promise<void>>();
  readonly #deliveryTasks = new Map<string, Promise<void>>();
  readonly #lastDeliveryAt = new Map<string, number>();
  readonly #nextFastDeliveryAt = new Map<string, number>();

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
        void this.#announceSessions().catch((error: unknown) => {
          this.#log('error', 'session_announcement_failed', { error: describeError(error) });
        });
        void this.#requestRuntimeSettings()
          .then(() => this.#drainQueue())
          .catch((error: unknown) => {
            this.#log('error', 'runtime_settings_failed', { error: describeError(error) });
            void this.#drainQueue().catch((drainError: unknown) => {
              this.#log('error', 'queue_drain_failed', { error: describeError(drainError) });
            });
          });
      },
      onCommand: async (command) => await this.#handleCommand(command.kind, command.payload),
    });

    await this.#adapter.start(async (message) => {
      try {
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
          fastMode: this.#fastMode,
        });
        if (queued !== false) {
          if (this.#fastMode) void this.#startFastUpload(validated.eventId);
          else this.#scheduleUploadBatch();
        }
      } catch (error) {
        this.#log('error', 'message_ingest_failed', { error: describeError(error) });
      }
    });
    try {
      await this.#client.connect();
    } catch (error) {
      this.#setRetrying(error);
    }
  }

  async stop(): Promise<void> {
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    if (this.#uploadBatchTimer) clearTimeout(this.#uploadBatchTimer);
    this.#retryTimer = undefined;
    this.#uploadBatchTimer = undefined;
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

  async #requestRuntimeSettings(): Promise<void> {
    await this.#client?.send('node.runtime.settings.request', {});
  }

  async #handleCommand(kind: string, payload: unknown): Promise<void> {
    if (kind === 'node.runtime.settings') {
      const settings = runtimeSettingsSchema.parse(payload);
      const wasFast = this.#fastMode;
      this.#fastMode = settings.fastMode;
      this.#fastDeliveryIntervalMs = settings.fastDeliveryIntervalMs;
      this.#log('info', 'runtime_settings_applied', {
        fastMode: this.#fastMode,
        fastDeliveryIntervalMs: this.#fastDeliveryIntervalMs,
      });
      if (this.#fastMode) {
        if (this.#uploadBatchTimer) clearTimeout(this.#uploadBatchTimer);
        this.#uploadBatchTimer = undefined;
        this.#uploadBatchStage = 0;
        if (!wasFast) {
          for (const item of this.#queue?.listRecoverable(100) ?? []) {
            if (item.kind === 'message.upload') void this.#startFastUpload(item.id);
          }
        }
      } else if (wasFast) {
        const hasUploads = this.#queue
          ?.listRecoverable(100)
          .some((item) => item.kind === 'message.upload');
        if (hasUploads) this.#scheduleUploadBatch();
      }
      return;
    }
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
        mode: command.mode,
      });
      // Persist and schedule in the background.  The command acknowledgement
      // is an acceptance acknowledgement, not a platform delivery receipt.
      if (!this.#queue) throw new Error('Node queue is not ready.');
      if (!this.#queue.get(command.taskId)) {
        this.#queue.enqueue({ id: command.taskId, kind: 'message.deliver', payload: command });
      }
      void this.#scheduleDelivery(command.taskId).catch((error: unknown) => {
        this.#log('error', 'delivery_task_failed', {
          taskId: command.taskId,
          error: describeError(error),
        });
      });
      return;
    }
    if (kind === 'message.deliver.batch') {
      const batch = deliverBatchCommandSchema.parse(payload);
      if (!this.#queue) throw new Error('Node queue is not ready.');
      this.#log('info', 'delivery_batch_queued', {
        batchId: batch.batchId,
        count: batch.deliveries.length,
      });
      // Persist every task before starting any of them.  The per-session
      // delivery chain then preserves the order from the central batch even
      // though each task is processed asynchronously.
      for (const command of batch.deliveries) {
        if (!this.#queue.get(command.taskId)) {
          this.#queue.enqueue({ id: command.taskId, kind: 'message.deliver', payload: command });
        }
      }
      for (const command of batch.deliveries) {
        void this.#scheduleDelivery(command.taskId).catch((error: unknown) => {
          this.#log('error', 'delivery_batch_item_failed', {
            batchId: batch.batchId,
            taskId: command.taskId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
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
    const key = queued.payload.fastMode ? queued.id : queued.payload.targetSessionId;
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
        await this.#waitForDeliveryGap(item.payload.targetSessionId, item.payload.fastMode);
        let firstMessageId: string | undefined;
        if (!this.#adapter) throw new Error('Platform adapter is not running.');
        if (item.payload.mode === 'text') {
          const prefix = item.payload.senderName ? `${item.payload.senderName}: ` : '';
          firstMessageId = await this.#adapter.sendText(
            item.payload.externalId,
            `${prefix}${item.payload.text ?? ''}`,
            item.payload.replyMessageId,
          );
        } else {
          for (const [index, card] of item.payload.cards.entries()) {
            const messageId = await this.#adapter.sendCard(
              item.payload.externalId,
              Buffer.from(card, 'base64'),
              index === 0 ? item.payload.replyMessageId : undefined,
            );
            firstMessageId ??= messageId;
          }
        }
        if (!firstMessageId) throw new Error('The platform did not return a message ID.');
        this.#lastDeliveryAt.set(item.payload.targetSessionId, Date.now());
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
    if (!this.#queue || !this.#client) return;
    if (this.#fastMode) {
      for (const item of this.#queue.listRecoverable(100)) {
        if (item.kind === 'message.upload') void this.#startFastUpload(item.id);
        else if (item.kind === 'message.deliver') {
          void this.#scheduleDelivery(item.id).catch((error: unknown) => {
            this.#log('error', 'delivery_recovery_failed', {
              taskId: item.id,
              error: describeError(error),
            });
          });
        }
      }
      return;
    }
    if (this.#draining) return;
    this.#draining = true;
    try {
      const recoverable = this.#queue.listRecoverable(100);
      const uploads = recoverable
        .filter((item) => item.kind === 'message.upload')
        .slice(0, MAX_UPLOAD_BATCH_SIZE) as QueueItem<MessageEnvelope>[];
      if (uploads.length) {
        const completed = await this.#processUploadBatch(uploads);
        if (!completed) return;
      }
      for (const item of recoverable) {
        if (item.kind === 'message.deliver') {
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
      const hasUploads = this.#queue
        ?.listRecoverable(100)
        .some((item) => item.kind === 'message.upload');
      if (hasUploads && !this.#retryTimer) this.#scheduleUploadBatch();
      else if (!hasUploads) this.#uploadBatchStage = 0;
    }
  }

  #startFastUpload(taskId: string): void {
    if (this.#fastUploadTasks.has(taskId)) return;
    const task = (async () => {
      const item = this.#queue?.get<MessageEnvelope>(taskId);
      if (!item || item.kind !== 'message.upload') return true;
      return await this.#processUploadBatch([item]);
    })();
    this.#fastUploadTasks.set(taskId, task);
    void task
      .catch((error: unknown) => {
        this.#log('error', 'fast_upload_failed', { taskId, error: describeError(error) });
      })
      .finally(() => {
        if (this.#fastUploadTasks.get(taskId) === task) this.#fastUploadTasks.delete(taskId);
        if (this.#fastMode && this.#queue?.get(taskId)?.status === 'retrying') {
          this.#scheduleDrain(FAST_UPLOAD_RETRY_DELAY_MS);
        }
      });
  }

  async #processUploadBatch(items: readonly QueueItem<MessageEnvelope>[]): Promise<boolean> {
    if (!this.#queue || !this.#client) return false;
    if (!items.length) return true;
    const eventIds = items.map((item) => item.id);
    try {
      for (const item of items) {
        if (item.status === 'processing') this.#queue.markRetrying(item.id);
        this.#queue.markProcessing(item.id);
      }
      this.#log('debug', 'message_upload_attempt_started', {
        eventIds,
        batchSize: items.length,
        attempt: Math.max(...items.map((item) => this.#queue?.get(item.id)?.attempts ?? 1)),
      });
      if (this.#fastMode && items.length === 1) {
        await this.#client.send('message.upload', items[0]!.payload);
      } else {
        await this.#client.send('message.upload.batch', {
          batchId: randomUUID(),
          messages: items.map((item) => item.payload),
        });
      }
      for (const item of items) this.#queue.markAcknowledged(item.id);
      this.#log(
        'info',
        items.length === 1 ? 'message_upload_acknowledged' : 'message_upload_batch_acknowledged',
        items.length === 1
          ? { eventId: eventIds[0] }
          : { eventIds, batchSize: items.length },
      );
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      let maxAttempts = 0;
      let deadLettered = false;
      for (const item of items) {
        const current = this.#queue.get(item.id);
        if (current?.status === 'processing') {
          maxAttempts = Math.max(maxAttempts, current.attempts);
          if (current.attempts >= 10) {
            this.#queue.markDeadLetter(item.id);
            deadLettered = true;
          } else {
            this.#queue.markRetrying(item.id);
          }
        }
      }
      this.#log(deadLettered ? 'error' : 'warn', deadLettered ? 'message_upload_dead_letter' : 'message_upload_retry_scheduled', {
        eventIds,
        batchSize: items.length,
        attempts: maxAttempts,
        error: message,
        ...(deadLettered ? {} : { nextDelayMs: retryDelay(maxAttempts) }),
      });
      if (!deadLettered) this.#scheduleDrain(retryDelay(maxAttempts));
      this.#setRetrying(error);
      return false;
    }
  }

  #scheduleUploadBatch(delayOverride?: number): void {
    if (this.#fastMode) {
      for (const item of this.#queue?.listRecoverable(100) ?? []) {
        if (item.kind === 'message.upload') void this.#startFastUpload(item.id);
      }
      return;
    }
    if (this.#uploadBatchTimer || this.#retryTimer || this.#draining) return;
    const delayMs =
      delayOverride ?? UPLOAD_BATCH_DELAYS_MS[Math.min(this.#uploadBatchStage, UPLOAD_BATCH_DELAYS_MS.length - 1)]!;
    if (delayOverride === undefined) {
      this.#uploadBatchStage = Math.min(
        this.#uploadBatchStage + 1,
        UPLOAD_BATCH_DELAYS_MS.length - 1,
      );
    }
    this.#log('debug', 'message_upload_batch_window_scheduled', {
      delayMs,
      stage: this.#uploadBatchStage,
    });
    this.#uploadBatchTimer = setTimeout(() => {
      this.#uploadBatchTimer = undefined;
      void this.#drainQueue().catch((error: unknown) => {
        this.#log('error', 'queue_drain_failed', { error: describeError(error) });
      });
    }, delayMs);
    this.#uploadBatchTimer.unref();
  }

  async #waitForDeliveryGap(targetSessionId: string, fastMode = false): Promise<void> {
    if (fastMode) {
      const now = Date.now();
      const slot = Math.max(now, this.#nextFastDeliveryAt.get(targetSessionId) ?? now);
      this.#nextFastDeliveryAt.set(targetSessionId, slot + this.#fastDeliveryIntervalMs);
      const waitMs = Math.max(0, slot - now);
      this.#log('debug', 'delivery_interval_scheduled', {
        targetSessionId,
        requestedGapMs: this.#fastDeliveryIntervalMs,
        waitMs,
        fastMode: true,
      });
      if (waitMs) await delay(waitMs);
      return;
    }
    const previous = this.#lastDeliveryAt.get(targetSessionId);
    if (previous === undefined) return;
    const gap = randomInteger(DELIVERY_MIN_GAP_MS, DELIVERY_MAX_GAP_MS);
    const waitMs = Math.max(0, previous + gap - Date.now());
    this.#log('debug', 'delivery_interval_scheduled', {
      targetSessionId,
      requestedGapMs: gap,
      waitMs,
    });
    if (waitMs) await delay(waitMs);
  }

  #scheduleDrain(delayMs: number): void {
    if (this.#retryTimer) return;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      void this.#drainQueue().catch((error: unknown) => {
        this.#log('error', 'queue_drain_failed', { error: describeError(error) });
      });
    }, this.#fastMode ? Math.min(delayMs, FAST_UPLOAD_RETRY_DELAY_MS) : delayMs);
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

function randomInteger(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
