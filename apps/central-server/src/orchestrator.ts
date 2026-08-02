import { randomUUID } from 'node:crypto';

import { validateBlueprint } from '@disqord/blueprint';
import {
  downloadExternalImage,
  renderMessageCards,
  type MessageCardInput,
} from '@disqord/card-renderer';
import {
  LlmModerationService,
  LlmTranslationService,
  OpenAICompatibleClient,
  getLlmFailureDetails,
  llmSettingsSchema,
  type ViolationAssessment,
} from '@disqord/llm';
import {
  blueprintVersionSchema,
  blueprintSchema,
  chatSessionSchema,
  createMessageIdempotencyKey,
  messageEnvelopeSchema,
  messageUploadBatchSchema,
  type Blueprint,
  type BlueprintEdge,
  type BlueprintNode,
  type BlueprintVersion,
  type ChatSession,
  type MessageEnvelope,
  type TranslationResult,
} from '@disqord/shared';
import { type ReceivedNodeFrame } from '@disqord/transport';
import { z } from 'zod';

import { type SecretStore, type StateStore } from './state-store.js';

const deliveredFrameSchema = z.object({
  taskId: z.uuid(),
  sourceSessionId: z.uuid(),
  sourceMessageId: z.string().min(1),
  targetSessionId: z.uuid(),
  targetMessageId: z.string().min(1),
});

const deliveryFailedFrameSchema = z.object({
  taskId: z.uuid(),
  sourceSessionId: z.uuid(),
  sourceMessageId: z.string().min(1),
  targetSessionId: z.uuid(),
  error: z.string().min(1).max(4_000),
});

const chatConfigSchema = z.object({ sessionId: z.uuid() });
const translationConfigSchema = z.object({
  prompt: z.string().trim().min(1).max(50_000),
  memoryMode: z.boolean().default(false),
});
const moderationConfigSchema = z.object({
  prompt: z.string().trim().min(1).max(50_000),
  threshold: z.number().min(0).max(1),
});
const fixedTextConfigSchema = z.object({ text: z.string().max(30_000) });
const MAX_DELIVERY_BATCH_BYTES = 6 * 1024 * 1024;

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function describeError(error: unknown): Record<string, unknown> {
  const base: Record<string, unknown> = {
    name: error instanceof Error ? error.name : 'UnknownError',
    message: error instanceof Error ? error.message : String(error),
  };
  if (error instanceof Error && error.stack) base.stack = error.stack.slice(0, 12_000);
  const llm = getLlmFailureDetails(error);
  if (llm) base.llm = llm;
  return base;
}

export interface NodeCommandBus {
  sendToNode(nodeId: string, kind: string, payload: unknown): Promise<void>;
}

export interface ProcessingResult {
  readonly decision: 'allow' | 'review' | 'block';
  readonly cards?: readonly Buffer[];
  readonly moderation?: unknown;
  readonly reason?: string;
}

export interface MessageProcessor {
  process?(message: MessageEnvelope, target: ChatSession): Promise<ProcessingResult>;
  processApproved?(message: MessageEnvelope, target: ChatSession): Promise<ProcessingResult>;
  translate?(
    message: MessageEnvelope,
    target: ChatSession,
    text: string,
    prompt: string,
    recentMessages: readonly MessageEnvelope[],
    memoryMode: boolean,
  ): Promise<TranslationResult>;
  moderate?(
    text: string,
    prompt: string,
    options?: {
      readonly imageReviewRequested?: boolean;
      readonly imageCount?: number;
      readonly imageUrls?: readonly string[];
    },
  ): Promise<ViolationAssessment>;
  render?(
    message: MessageEnvelope,
    target: ChatSession,
    text: string,
    fixedText: boolean,
  ): Promise<readonly Buffer[]>;
}

interface PipelineState {
  readonly text: string;
  readonly fixedText: boolean;
  readonly cards?: readonly Buffer[];
  readonly renderedForSessionId?: string;
}

interface WorkItem {
  readonly nodeId: string;
  readonly state: PipelineState;
}

interface DeliveryIntent {
  readonly blueprint: BlueprintVersion;
  readonly sourceSession: ChatSession;
  readonly target: ChatSession;
  readonly message: MessageEnvelope;
  readonly cards: readonly Buffer[];
  readonly processedText: string;
}

interface OutboundDeliveryCommand {
  readonly taskId: string;
  readonly sourceSessionId: string;
  readonly sourceMessageId: string;
  readonly targetSessionId: string;
  readonly externalId: string;
  readonly cards: readonly string[];
  readonly replyMessageId?: string;
}

interface PreparedDelivery {
  readonly intent: DeliveryIntent;
  readonly command: OutboundDeliveryCommand;
}

interface BlueprintFlowSimulationStep {
  readonly nodeId: string;
  readonly nodeType: string;
  readonly message: string;
  readonly text?: string;
  readonly violationScore?: number;
  readonly route?: 'passed' | 'blocked';
}

interface BlueprintFlowSimulationResult {
  readonly inputText: string;
  readonly outputText: string;
  readonly outputSessionId?: string;
  readonly steps: readonly BlueprintFlowSimulationStep[];
}

interface ManualReviewRecord {
  readonly taskId: string;
  readonly traceId: string;
  readonly status: 'pending' | 'processing' | 'approved' | 'rejected';
  readonly reason: string;
  readonly blueprintId: string;
  readonly blueprintVersion: number;
  readonly reviewNodeId: string;
  readonly sourceSessionId: string;
  readonly sourceSession?: ChatSession;
  readonly message: MessageEnvelope;
  readonly recentMessages: readonly MessageEnvelope[];
  readonly state: Pick<PipelineState, 'text' | 'fixedText'>;
  readonly createdAt: string;
  readonly resolvedAt?: string;
  readonly error?: string;
}

interface BlueprintActivityRecord {
  readonly id: string;
  readonly blueprintId: string;
  readonly version: number;
  readonly traceId: string;
  readonly nodeId: string;
  readonly nodeType: string;
  readonly phase: 'entered' | 'completed' | 'failed';
  readonly message: string;
  readonly text?: string;
  readonly violationScore?: number;
  readonly route?: 'passed' | 'blocked';
  readonly step: number;
  readonly sequence: number;
  readonly createdAt: string;
}

export class MessageOrchestrator {
  readonly #store: StateStore;
  readonly #commandBus: NodeCommandBus;
  readonly #processor: MessageProcessor;
  #activitySequence = 0;

  constructor(store: StateStore, commandBus: NodeCommandBus, processor: MessageProcessor) {
    this.#store = store;
    this.#commandBus = commandBus;
    this.#processor = processor;
  }

  async handleNodeFrame(frame: ReceivedNodeFrame): Promise<void> {
    if (frame.kind === 'message.upload') {
      await this.#handleMessageUpload(frame);
    } else if (frame.kind === 'message.upload.batch') {
      await this.#handleMessageUploadBatch(frame);
    } else if (frame.kind === 'message.delivered') {
      await this.#handleDelivered(frame.payload);
    } else if (frame.kind === 'message.delivery_failed') {
      await this.#handleDeliveryFailed(frame.payload);
    } else if (frame.kind === 'session.candidates') {
      await this.#store.set('session-candidates', frame.nodeId, frame.payload);
    }
  }

  async simulateBlueprint(
    blueprint: BlueprintVersion,
    inputSessionId: string,
    outputSessionId: string,
    text: string,
  ): Promise<BlueprintFlowSimulationResult> {
    const sessions = (await this.#store.list<ChatSession>('chat-session'))
      .map((entry) => chatSessionSchema.parse(entry.value))
      .filter((session) => session.status === 'verified');
    const sourceSession = sessions.find((session) => session.id === inputSessionId);
    const targetSession = sessions.find((session) => session.id === outputSessionId);
    if (!sourceSession) throw new Error('模拟输入会话不存在或尚未验证。');
    if (!targetSession) throw new Error('模拟输出会话不存在或尚未验证。');

    const validation = validateBlueprint(blueprint, {
      isVerifiedSession: (id) => sessions.some((session) => session.id === id),
    });
    if (!validation.valid) {
      throw new Error(`蓝图无效：${validation.errors.map((error) => error.code).join(', ')}`);
    }

    const nodes = new Map(blueprint.nodes.map((node) => [node.id, node]));
    const outgoing = new Map<string, BlueprintEdge[]>();
    for (const edge of blueprint.edges) {
      const current = outgoing.get(edge.sourceNodeId) ?? [];
      current.push(edge);
      outgoing.set(edge.sourceNodeId, current);
    }
    const starts = blueprint.nodes.filter(
      (node) =>
        node.type === 'chat-input' &&
        chatConfigSchema.parse(node.config).sessionId === inputSessionId,
    );
    if (!starts.length) throw new Error('蓝图中没有对应模拟输入会话的消息入口。');
    const hasTarget = blueprint.nodes.some(
      (node) =>
        node.type === 'chat-output' &&
        chatConfigSchema.parse(node.config).sessionId === outputSessionId,
    );
    if (!hasTarget) throw new Error('蓝图中没有对应模拟输出会话的发送目标。');

    const canReachTarget = (startNodeId: string): boolean => {
      const pending = [startNodeId];
      const seen = new Set<string>();
      while (pending.length) {
        const nodeId = pending.shift()!;
        if (seen.has(nodeId)) continue;
        seen.add(nodeId);
        const node = nodes.get(nodeId);
        if (
          node?.type === 'chat-output' &&
          chatConfigSchema.parse(node.config).sessionId === outputSessionId
        ) {
          return true;
        }
        pending.push(...(outgoing.get(nodeId) ?? []).map((edge) => edge.targetNodeId));
      }
      return false;
    };

    const message = messageEnvelopeSchema.parse({
      schemaVersion: 1,
      eventId: randomUUID(),
      source: {
        nodeId: sourceSession.nodeId,
        platform: sourceSession.platform,
        spaceId: sourceSession.spaceId,
        channelId: sourceSession.externalId,
        messageId: randomUUID(),
      },
      sender: { id: 'blueprint-simulator', displayName: '蓝图模拟器' },
      sentAt: new Date().toISOString(),
      kind: 'text',
      text,
      attachments: [],
      traceId: randomUUID(),
    });
    const work: WorkItem[] = starts
      .filter((node) => canReachTarget(node.id))
      .map((node) => ({ nodeId: node.id, state: { text, fixedText: false } }));
    const steps: BlueprintFlowSimulationStep[] = [];
    let outputText = '';
    let reachedOutputSessionId: string | undefined;
    let processedSteps = 0;

    while (work.length) {
      if ((processedSteps += 1) > 2_000) throw new Error('蓝图模拟步骤超过安全限制。');
      const item = work.shift()!;
      const node = nodes.get(item.nodeId);
      if (!node) continue;
      let state = item.state;

      if (node.type === 'chat-input') {
        steps.push({
          nodeId: node.id,
          nodeType: node.type,
          message: '收到测试消息',
          text: state.text,
        });
      } else if (node.type === 'llm-translation' && state.text.trim()) {
        const config = translationConfigSchema.parse(node.config);
        if (!this.#processor.translate) throw new Error('翻译处理器不可用。');
        const result = await this.#processor.translate(
          message,
          targetSession,
          state.text,
          config.prompt,
          [],
          config.memoryMode,
        );
        state = { ...state, text: result.translatedText, fixedText: false };
        steps.push({
          nodeId: node.id,
          nodeType: node.type,
          message: `翻译结果：${result.translatedText}`,
          text: result.translatedText,
        });
      } else if (node.type === 'llm-moderation') {
        const config = moderationConfigSchema.parse(node.config);
        if (!this.#processor.moderate) throw new Error('审核处理器不可用。');
        const assessment = state.text.trim()
          ? await this.#processor.moderate(state.text, config.prompt)
          : {
              violationScore: 0,
              categories: [],
              reason: '没有可审核的文本。',
              confidence: 1,
              model: 'skipped-empty-text',
            };
        const route = assessment.violationScore <= config.threshold ? 'passed' : 'blocked';
        steps.push({
          nodeId: node.id,
          nodeType: node.type,
          message: `此消息违规程度为 ${Math.round(assessment.violationScore * 100)}%，走“${route === 'passed' ? '通过' : '拦截'}”出口`,
          text: state.text,
          violationScore: assessment.violationScore,
          route,
        });
        for (const edge of outgoing.get(node.id) ?? []) {
          if (edge.sourceHandle === route && canReachTarget(edge.targetNodeId)) {
            work.push({ nodeId: edge.targetNodeId, state });
          }
        }
        continue;
      } else if (node.type === 'fixed-text') {
        const config = fixedTextConfigSchema.parse(node.config);
        state = { text: config.text, fixedText: true };
        steps.push({
          nodeId: node.id,
          nodeType: node.type,
          message: `固定文本：${config.text || '[空文本]'}`,
          text: config.text,
        });
      } else if (node.type === 'manual-review') {
        steps.push({
          nodeId: node.id,
          nodeType: node.type,
          message: '模拟模式不创建审核任务，自动走“通过”出口',
          text: state.text,
          route: 'passed',
        });
        for (const edge of outgoing.get(node.id) ?? []) {
          if (edge.sourceHandle === 'passed' && canReachTarget(edge.targetNodeId)) {
            work.push({ nodeId: edge.targetNodeId, state });
          }
        }
        continue;
      } else if (node.type === 'card-renderer') {
        steps.push({
          nodeId: node.id,
          nodeType: node.type,
          message: '将使用原消息资料和当前文本合成图片',
          text: state.text,
        });
      } else if (node.type === 'chat-output') {
        const targetId = chatConfigSchema.parse(node.config).sessionId;
        if (targetId !== outputSessionId) continue;
        outputText = state.text;
        reachedOutputSessionId = targetId;
        steps.push({
          nodeId: node.id,
          nodeType: node.type,
          message: `模拟输出到 ${targetSession.remark || targetSession.displayName}；不会真正发送`,
          text: state.text,
        });
        continue;
      } else if (node.type === 'discard') {
        steps.push({
          nodeId: node.id,
          nodeType: node.type,
          message: '消息在此处被丢弃',
          text: state.text,
        });
        continue;
      } else {
        steps.push({
          nodeId: node.id,
          nodeType: node.type,
          message: '已通过此模块',
          text: state.text,
        });
      }

      for (const edge of outgoing.get(node.id) ?? []) {
        if (canReachTarget(edge.targetNodeId)) work.push({ nodeId: edge.targetNodeId, state });
      }
    }

    return {
      inputText: text,
      outputText,
      ...(reachedOutputSessionId ? { outputSessionId: reachedOutputSessionId } : {}),
      steps,
    };
  }

  async handleSimulatedInput(
    blueprintId: string,
    nodeId: string,
    text: string,
  ): Promise<{ traceId: string }> {
    const blueprintEntry = await this.#store.get<Blueprint>('blueprint', blueprintId);
    if (!blueprintEntry) throw new Error('蓝图不存在。');
    const blueprint = blueprintSchema.parse(blueprintEntry.value);
    if (!blueprint.enabled || blueprint.activeVersion === undefined) {
      throw new Error('请先保存并发布蓝图，再使用模拟输入。');
    }
    const versionEntry = await this.#store.get<BlueprintVersion>(
      'blueprint-version',
      `${blueprintId}:${blueprint.activeVersion}`,
    );
    if (!versionEntry) throw new Error('找不到蓝图当前发布版本。');
    const version = blueprintVersionSchema.parse(versionEntry.value);
    const simulatedInput = version.nodes.find(
      (node) => node.id === nodeId && node.type === 'simulated-input',
    );
    if (!simulatedInput) throw new Error('当前发布版本中没有这个模拟输入节点。');

    const sessions = (await this.#store.list<ChatSession>('chat-session'))
      .map((entry) => chatSessionSchema.parse(entry.value))
      .filter((session) => session.status === 'verified');
    const validation = validateBlueprint(version, {
      isVerifiedSession: (id) => sessions.some((session) => session.id === id),
    });
    if (!validation.valid) {
      throw new Error(`蓝图无效：${validation.errors.map((error) => error.code).join(', ')}`);
    }

    const nodes = new Map(version.nodes.map((node) => [node.id, node]));
    const outgoing = new Map<string, BlueprintEdge[]>();
    for (const edge of version.edges) {
      const current = outgoing.get(edge.sourceNodeId) ?? [];
      current.push(edge);
      outgoing.set(edge.sourceNodeId, current);
    }
    const firstTarget = this.#findDownstreamTarget(nodeId, nodes, outgoing, sessions);
    const now = new Date().toISOString();
    const sourceSession: ChatSession = {
      id: randomUUID(),
      nodeId: randomUUID(),
      platform: firstTarget?.platform === 'qq' ? 'discord' : 'qq',
      externalId: 'simulated-input',
      spaceId: 'simulated-input',
      displayName: '模拟输入',
      status: 'verified',
      verifiedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    const traceId = randomUUID();
    const message = messageEnvelopeSchema.parse({
      schemaVersion: 1,
      eventId: randomUUID(),
      source: {
        nodeId: sourceSession.nodeId,
        platform: sourceSession.platform,
        spaceId: sourceSession.spaceId,
        channelId: sourceSession.externalId,
        messageId: randomUUID(),
      },
      sender: { id: 'blueprint-simulator', displayName: '蓝图模拟器' },
      sentAt: now,
      kind: 'text',
      text,
      attachments: [],
      traceId,
    });

    await this.#log(traceId, 'info', 'blueprint_started', {
      blueprintId,
      version: version.version,
      simulatedInput: true,
    });
    try {
      const result = await this.#executeBlueprint(
        version,
        sourceSession,
        sessions,
        message,
        [],
        [{ nodeId, state: { text, fixedText: false } }],
      );
      await this.#log(traceId, 'info', result.paused ? 'blueprint_paused' : 'blueprint_completed', {
        blueprintId,
        version: version.version,
        simulatedInput: true,
      });
    } catch (error) {
      await this.#log(traceId, 'error', 'blueprint_failed', {
        blueprintId,
        version: version.version,
        simulatedInput: true,
        error: error instanceof Error ? error.message : String(error),
        errorDetails: describeError(error),
      });
      throw error;
    }
    return { traceId };
  }

  async #handleMessageUpload(
    frame: ReceivedNodeFrame,
    messagePayload: unknown = frame.payload,
    deliveryCollector?: DeliveryIntent[],
    strict = false,
  ): Promise<void> {
    const message = messageEnvelopeSchema.parse(messagePayload);
    if (message.source.nodeId !== frame.nodeId || message.source.platform !== frame.nodeType) {
      throw new Error('Uploaded message source does not match the authenticated node.');
    }
    const sessions = (await this.#store.list<ChatSession>('chat-session'))
      .map((entry) => chatSessionSchema.parse(entry.value))
      .filter((session) => session.status === 'verified');
    const sourceSession = sessions.find(
      (session) =>
        session.nodeId === frame.nodeId &&
        session.platform === frame.nodeType &&
        session.externalId === message.source.channelId,
    );
    if (!sourceSession) return;

    const dedupeKey = createMessageIdempotencyKey(message);
    if (await this.#store.get('message-dedupe', dedupeKey)) {
      await this.#log(message.traceId, 'debug', 'message_deduplicated', { dedupeKey });
      return;
    }
    await this.#store.set('message-dedupe', dedupeKey, {
      eventId: message.eventId,
      receivedAt: new Date().toISOString(),
    });
    await this.#log(message.traceId, 'info', 'message_received', {
      authenticatedNode: { nodeId: frame.nodeId, nodeType: frame.nodeType },
      message,
    });
    await this.#log(message.traceId, 'debug', 'source_session_matched', { sourceSession });

    const recentMessages = await this.#recentMessages(sourceSession.id);
    await this.#store.set('message-history', randomUUID(), {
      sessionId: sourceSession.id,
      message,
      createdAt: new Date().toISOString(),
    });

    const blueprints = (await this.#store.list<Blueprint>('blueprint')).map((entry) =>
      blueprintSchema.parse(entry.value),
    );
    const enabledVersions = new Map(
      blueprints
        .filter((blueprint) => blueprint.enabled && blueprint.activeVersion !== undefined)
        .map((blueprint) => [blueprint.id, blueprint.activeVersion]),
    );
    const published = (await this.#store.list<BlueprintVersion>('blueprint-version'))
      .map((entry) => blueprintVersionSchema.parse(entry.value))
      .filter(
        (version) =>
          version.status === 'published' &&
          enabledVersions.get(version.blueprintId) === version.version,
      );
    const verifiedIds = new Set(sessions.map((session) => session.id));
    const matching = published.filter((blueprint) =>
      blueprint.nodes.some(
        (node) =>
          node.type === 'chat-input' &&
          chatConfigSchema.safeParse(node.config).success &&
          chatConfigSchema.parse(node.config).sessionId === sourceSession.id,
      ),
    );

    if (!matching.length) {
      await this.#log(message.traceId, 'warn', 'unmatched_blueprint', {
        sessionId: sourceSession.id,
      });
      return;
    }

    for (const blueprint of matching) {
      const validation = validateBlueprint(blueprint, {
        isVerifiedSession: (sessionId) => verifiedIds.has(sessionId),
      });
      if (!validation.valid) {
        await this.#log(message.traceId, 'error', 'blueprint_invalid', {
          blueprintId: blueprint.blueprintId,
          version: blueprint.version,
          errors: validation.errors,
        });
        continue;
      }
      await this.#log(message.traceId, 'info', 'blueprint_started', {
        blueprintId: blueprint.blueprintId,
        version: blueprint.version,
      });
      try {
        const result = await this.#executeBlueprint(
          blueprint,
          sourceSession,
          sessions,
          message,
          recentMessages,
          undefined,
          deliveryCollector,
        );
        await this.#log(
          message.traceId,
          'info',
          result.paused ? 'blueprint_paused' : 'blueprint_completed',
          {
            blueprintId: blueprint.blueprintId,
            version: blueprint.version,
          },
        );
      } catch (error) {
        await this.#log(message.traceId, 'error', 'blueprint_failed', {
          blueprintId: blueprint.blueprintId,
          version: blueprint.version,
          error: error instanceof Error ? error.message : String(error),
          errorDetails: describeError(error),
        });
        if (strict) {
          await this.#store.delete('message-dedupe', dedupeKey);
          throw error;
        }
      }
    }
  }

  async #handleMessageUploadBatch(frame: ReceivedNodeFrame): Promise<void> {
    const batch = messageUploadBatchSchema.parse(frame.payload);
    const messages = batch.messages;
    const collectors = messages.map(() => [] as DeliveryIntent[]);
    const concurrency = await this.#configuredLlmConcurrency();
    let nextIndex = 0;
    const failures: { index: number; error: unknown }[] = [];
    const worker = async (): Promise<void> => {
      while (true) {
        const index = nextIndex++;
        if (index >= messages.length) return;
        try {
          await this.#handleMessageUpload(frame, messages[index], collectors[index], true);
        } catch (error) {
          failures.push({ index, error });
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrency, messages.length) }, () => worker()),
    );
    await this.#log(
      messages[0]!.traceId,
      failures.length ? 'error' : 'info',
      failures.length ? 'message_upload_batch_failed' : 'message_upload_batch_processed',
      {
        batchId: batch.batchId,
        batchSize: messages.length,
        concurrency: Math.min(concurrency, messages.length),
        eventIds: messages.map((message) => message.eventId),
        failures: failures.map(({ index, error }) => ({
          index,
          eventId: messages[index]?.eventId,
          error: describeError(error),
        })),
      },
    );
    if (failures.length) {
      for (const message of messages) {
        await this.#store.delete('message-dedupe', createMessageIdempotencyKey(message));
      }
      throw failures[0]!.error;
    }

    // Preserve the node's receive order even though each message's LLM work
    // ran concurrently.  The target node has its own per-session queue and
    // will send these tasks one by one.
    const deliveries = collectors.flat();
    if (deliveries.length) await this.#dispatchDeliveryBatch(deliveries);
    await this.#log(messages[0]!.traceId, 'info', 'message_upload_batch_deliveries_queued', {
      batchId: batch.batchId,
      batchSize: messages.length,
      deliveryCount: deliveries.length,
    });
  }

  async #configuredLlmConcurrency(): Promise<number> {
    const entry = await this.#store.get('settings', 'llm');
    if (!entry) return 4;
    const parsed = llmSettingsSchema.safeParse(entry.value);
    return parsed.success ? parsed.data.concurrency : 4;
  }

  async #executeBlueprint(
    blueprint: BlueprintVersion,
    sourceSession: ChatSession,
    sessions: readonly ChatSession[],
    message: MessageEnvelope,
    recentMessages: readonly MessageEnvelope[],
    initialWork?: readonly WorkItem[],
    deliveryCollector?: DeliveryIntent[],
  ): Promise<{ paused: boolean }> {
    const nodes = new Map(blueprint.nodes.map((node) => [node.id, node]));
    const outgoing = new Map<string, BlueprintEdge[]>();
    for (const edge of blueprint.edges) {
      const current = outgoing.get(edge.sourceNodeId) ?? [];
      current.push(edge);
      outgoing.set(edge.sourceNodeId, current);
    }
    const starts = blueprint.nodes.filter(
      (node) =>
        node.type === 'chat-input' &&
        chatConfigSchema.parse(node.config).sessionId === sourceSession.id,
    );
    const work: WorkItem[] = initialWork
      ? [...initialWork]
      : starts.map((node) => ({
          nodeId: node.id,
          state: { text: message.text ?? '', fixedText: false },
        }));
    let processedSteps = 0;
    let paused = false;
    const moderationImageRefs = [
      ...message.attachments,
      ...(message.replyTo?.imagePreview ? [message.replyTo.imagePreview] : []),
    ];
    const moderationOptions = moderationImageRefs.length
      ? {
          imageReviewRequested: true,
          imageCount: moderationImageRefs.length,
          imageUrls: moderationImageRefs.flatMap((image) =>
            image.sourceUrl ? [image.sourceUrl] : [],
          ),
        }
      : undefined;

    while (work.length) {
      if ((processedSteps += 1) > 2_000)
        throw new Error('Blueprint execution step limit exceeded.');
      const item = work.shift()!;
      const node = nodes.get(item.nodeId);
      if (!node) continue;
      let state = item.state;
      await this.#log(message.traceId, 'debug', 'blueprint_node_entered', {
        blueprintId: blueprint.blueprintId,
        version: blueprint.version,
        nodeId: node.id,
        nodeType: node.type,
        currentText: state.text,
      });
      await this.#recordActivity(blueprint, message, node, processedSteps, {
        phase: 'entered',
        message: '消息已到达，准备运行此节点',
        text: state.text,
      });

      if (node.type === 'chat-input' || node.type === 'simulated-input') {
        await this.#recordActivity(blueprint, message, node, processedSteps, {
          message: node.type === 'simulated-input' ? '模拟消息已进入流程' : '收到消息',
          text: state.text,
        });
      }

      if (node.type === 'llm-translation' && state.text.trim()) {
        const config = translationConfigSchema.parse(node.config);
        const target =
          this.#findDownstreamTarget(node.id, nodes, outgoing, sessions) ??
          this.#simulatedTranslationTarget(sourceSession);
        if (!this.#processor.translate) throw new Error('Translation processor is unavailable.');
        await this.#log(message.traceId, 'debug', 'translation_requested', {
          nodeId: node.id,
          modelTarget: target.platform === 'discord' ? 'en' : 'zh',
          prompt: config.prompt,
          memoryMode: config.memoryMode,
          inputText: state.text,
          recentMessages: config.memoryMode ? recentMessages : [],
          repliedMessage: config.memoryMode ? message.replyTo : undefined,
        });
        let result: TranslationResult;
        try {
          result = await this.#processor.translate(
            message,
            target,
            state.text,
            config.prompt,
            recentMessages,
            config.memoryMode,
          );
        } catch (error) {
          const errorDetails = describeError(error);
          await this.#log(message.traceId, 'error', 'translation_failed', {
            nodeId: node.id,
            modelTarget: target.platform === 'discord' ? 'en' : 'zh',
            inputText: state.text,
            error: errorDetails,
          });
          const llm = getLlmFailureDetails(error);
          if (llm) {
            await this.#log(message.traceId, 'error', 'llm_request_failed', {
              nodeId: node.id,
              nodeType: node.type,
              operation: 'translation',
              failure: llm,
            });
          }
          throw error;
        }
        await this.#log(message.traceId, 'info', 'translation_response', {
          nodeId: node.id,
          rawResult: result,
        });
        state = { ...state, text: result.translatedText, fixedText: false };
        await this.#recordActivity(blueprint, message, node, processedSteps, {
          message: `翻译结果：${result.translatedText}`,
          text: result.translatedText,
        });
      } else if (node.type === 'llm-moderation') {
        const config = moderationConfigSchema.parse(node.config);
        let assessment: ViolationAssessment;
        if (!state.text.trim() && !moderationOptions?.imageReviewRequested) {
          assessment = {
            violationScore: 0,
            categories: [],
            reason: '消息没有可供文本审核模块处理的文字。',
            confidence: 1,
            model: 'skipped-empty-text',
          };
        } else {
          if (!this.#processor.moderate) throw new Error('Moderation processor is unavailable.');
          await this.#log(message.traceId, 'debug', 'moderation_requested', {
            nodeId: node.id,
            threshold: config.threshold,
            prompt: config.prompt,
            inputText: state.text,
            ...(moderationOptions?.imageReviewRequested
              ? { imageCount: moderationOptions.imageCount }
              : {}),
          });
          try {
            assessment = moderationOptions
              ? await this.#processor.moderate(state.text, config.prompt, moderationOptions)
              : await this.#processor.moderate(state.text, config.prompt);
          } catch (error) {
            const errorDetails = describeError(error);
            await this.#log(message.traceId, 'error', 'moderation_failed', {
              nodeId: node.id,
              threshold: config.threshold,
              inputText: state.text,
              ...(moderationOptions?.imageReviewRequested
                ? { imageCount: moderationOptions.imageCount }
                : {}),
              error: errorDetails,
            });
            const llm = getLlmFailureDetails(error);
            if (llm) {
              await this.#log(message.traceId, 'error', 'llm_request_failed', {
                nodeId: node.id,
                nodeType: node.type,
                operation: 'moderation',
                failure: llm,
              });
            }
            throw error;
          }
        }
        const imageReviewUnavailable = assessment.model === 'image-review-unavailable';
        const passed = !imageReviewUnavailable && assessment.violationScore <= config.threshold;
        await this.#log(message.traceId, 'info', 'moderation_response', {
          nodeId: node.id,
          threshold: config.threshold,
          passed,
          selectedOutput: passed ? 'passed' : 'blocked',
          rawResult: assessment,
        });
        await this.#recordActivity(blueprint, message, node, processedSteps, {
          message: `此消息违规程度为 ${Math.round(assessment.violationScore * 100)}%，走“${passed ? '过审' : '未过'}”出口`,
          text: state.text,
          violationScore: assessment.violationScore,
          route: passed ? 'passed' : 'blocked',
        });
        const selectedEdges = (outgoing.get(node.id) ?? []).filter(
          (edge) => edge.sourceHandle === (passed ? 'passed' : 'blocked'),
        );
        for (const edge of selectedEdges) {
          work.push({ nodeId: edge.targetNodeId, state });
        }
        continue;
      } else if (node.type === 'fixed-text') {
        const config = fixedTextConfigSchema.parse(node.config);
        state = { text: config.text, fixedText: true };
        await this.#log(message.traceId, 'debug', 'fixed_text_applied', {
          nodeId: node.id,
          outputText: config.text,
        });
        await this.#recordActivity(blueprint, message, node, processedSteps, {
          message: `固定文本：${config.text || '[空文本]'}`,
          text: config.text,
        });
      } else if (node.type === 'manual-review') {
        const taskId = randomUUID();
        const review: ManualReviewRecord = {
          taskId,
          traceId: message.traceId,
          status: 'pending',
          reason: state.text || '[无文本内容]',
          blueprintId: blueprint.blueprintId,
          blueprintVersion: blueprint.version,
          reviewNodeId: node.id,
          sourceSessionId: sourceSession.id,
          sourceSession,
          message,
          recentMessages,
          state: { text: state.text, fixedText: state.fixedText },
          createdAt: new Date().toISOString(),
        };
        await this.#store.set('moderation-review', taskId, review);
        await this.#log(message.traceId, 'info', 'manual_review_created', {
          taskId,
          nodeId: node.id,
          inputText: state.text,
        });
        await this.#recordActivity(blueprint, message, node, processedSteps, {
          message: '等待人工审核',
          text: state.text,
        });
        paused = true;
        continue;
      } else if (node.type === 'card-renderer') {
        const target = this.#findDownstreamTarget(node.id, nodes, outgoing, sessions);
        if (!target) throw new Error('Image renderer has no reachable verified target session.');
        const cards = await this.#render(message, target, state.text, state.fixedText);
        state = { ...state, cards, renderedForSessionId: target.id };
        await this.#log(message.traceId, 'info', 'render_succeeded', {
          nodeId: node.id,
          targetSessionId: target.id,
          cardCount: cards.length,
          byteSizes: cards.map((card) => card.byteLength),
        });
        await this.#recordActivity(blueprint, message, node, processedSteps, {
          message: `已合成 ${cards.length} 张消息图片`,
          text: state.text,
        });
      } else if (node.type === 'chat-output') {
        const targetId = chatConfigSchema.parse(node.config).sessionId;
        const target = sessions.find((session) => session.id === targetId);
        if (!target) throw new Error(`Target session ${targetId} is unavailable.`);
        const cards =
          state.cards && state.renderedForSessionId === target.id
            ? state.cards
            : await this.#render(message, target, state.text, state.fixedText);
        const delivery: DeliveryIntent = {
          blueprint,
          sourceSession,
          target,
          message,
          cards,
          processedText: state.text,
        };
        if (deliveryCollector) deliveryCollector.push(delivery);
        else await this.#dispatchDelivery(
          blueprint,
          sourceSession,
          target,
          message,
          cards,
          state.text,
        );
        await this.#recordActivity(blueprint, message, node, processedSteps, {
          message: `已发送到 ${target.remark?.trim() || target.displayName}`,
          text: state.text,
        });
        continue;
      } else if (node.type === 'simulated-output') {
        await this.#recordActivity(blueprint, message, node, processedSteps, {
          message: '模拟输出已收到结果',
          text: state.text,
        });
        continue;
      } else if (node.type === 'discard') {
        await this.#log(message.traceId, 'info', 'message_discarded', { nodeId: node.id });
        await this.#recordActivity(blueprint, message, node, processedSteps, {
          message: '消息已丢弃',
          text: state.text,
        });
        continue;
      } else if (node.type !== 'chat-input' && node.type !== 'simulated-input') {
        await this.#recordActivity(blueprint, message, node, processedSteps, {
          message: '消息已通过此模块',
          text: state.text,
        });
      }

      for (const edge of outgoing.get(node.id) ?? []) {
        work.push({ nodeId: edge.targetNodeId, state });
      }
    }
    return { paused };
  }

  #simulatedTranslationTarget(sourceSession: ChatSession): ChatSession {
    const now = new Date().toISOString();
    return {
      ...sourceSession,
      id: randomUUID(),
      nodeId: randomUUID(),
      platform: sourceSession.platform === 'qq' ? 'discord' : 'qq',
      externalId: 'simulated-output',
      spaceId: 'simulated-output',
      displayName: '模拟输出',
      verifiedAt: now,
      createdAt: now,
      updatedAt: now,
    };
  }

  async #recordActivity(
    blueprint: BlueprintVersion,
    message: MessageEnvelope,
    node: BlueprintNode,
    step: number,
    detail: Pick<BlueprintActivityRecord, 'message' | 'text' | 'violationScore' | 'route'> &
      Partial<Pick<BlueprintActivityRecord, 'phase'>>,
  ): Promise<void> {
    const id = randomUUID();
    this.#activitySequence = Math.max(Date.now() * 1_000, this.#activitySequence + 1);
    const record: BlueprintActivityRecord = {
      id,
      blueprintId: blueprint.blueprintId,
      version: blueprint.version,
      traceId: message.traceId,
      nodeId: node.id,
      nodeType: node.type,
      phase: detail.phase ?? 'completed',
      message: detail.message,
      ...(detail.text === undefined ? {} : { text: detail.text }),
      ...(detail.violationScore === undefined ? {} : { violationScore: detail.violationScore }),
      ...(detail.route === undefined ? {} : { route: detail.route }),
      step,
      sequence: this.#activitySequence,
      createdAt: new Date().toISOString(),
    };
    await this.#store.set('blueprint-activity', id, record);
  }

  #findDownstreamTarget(
    startNodeId: string,
    nodes: ReadonlyMap<string, BlueprintNode>,
    outgoing: ReadonlyMap<string, readonly BlueprintEdge[]>,
    sessions: readonly ChatSession[],
  ): ChatSession | undefined {
    const queue = (outgoing.get(startNodeId) ?? []).map((edge) => edge.targetNodeId);
    const visited = new Set<string>();
    while (queue.length) {
      const nodeId = queue.shift()!;
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);
      const node = nodes.get(nodeId);
      if (!node) continue;
      if (node.type === 'chat-output') {
        const targetId = chatConfigSchema.parse(node.config).sessionId;
        return sessions.find((session) => session.id === targetId);
      }
      queue.push(...(outgoing.get(nodeId) ?? []).map((edge) => edge.targetNodeId));
    }
    return undefined;
  }

  async #render(
    message: MessageEnvelope,
    target: ChatSession,
    text: string,
    fixedText: boolean,
  ): Promise<readonly Buffer[]> {
    if (this.#processor.render)
      return await this.#processor.render(message, target, text, fixedText);
    if (this.#processor.process) {
      const legacy = await this.#processor.process(message, target);
      if (legacy.cards?.length) return legacy.cards;
    }
    throw new Error('Card renderer is unavailable.');
  }

  async #dispatchDelivery(
    blueprint: BlueprintVersion,
    sourceSession: ChatSession,
    target: ChatSession,
    message: MessageEnvelope,
    cards: readonly Buffer[],
    processedText: string,
  ): Promise<void> {
    const prepared = await this.#prepareDelivery({
      blueprint,
      sourceSession,
      target,
      message,
      cards,
      processedText,
    });
    await this.#sendPreparedDelivery(prepared);
  }

  async #prepareDelivery(intent: DeliveryIntent): Promise<PreparedDelivery> {
    const { blueprint, sourceSession, target, message, cards, processedText } = intent;
    const taskId = randomUUID();
    const now = new Date().toISOString();
    await this.#store.set('delivery-task', taskId, {
      id: taskId,
      traceId: message.traceId,
      blueprintId: blueprint.blueprintId,
      blueprintVersion: blueprint.version,
      sourceSessionId: sourceSession.id,
      targetSessionId: target.id,
      status: 'queued',
      processedText,
      cardCount: cards.length,
      createdAt: now,
      updatedAt: now,
    });
    const mappedReplyId = message.replyTo
      ? (
          await this.#store.get<{ targetMessageId: string }>(
            'reply-mapping',
            mappingKey(sourceSession.id, message.replyTo.sourceMessageId, target.id),
          )
        )?.value.targetMessageId
      : undefined;
    const command: OutboundDeliveryCommand = {
      taskId,
      sourceSessionId: sourceSession.id,
      sourceMessageId: message.source.messageId,
      targetSessionId: target.id,
      externalId: target.externalId,
      cards: cards.map((card) => card.toString('base64')),
      ...(mappedReplyId ? { replyMessageId: mappedReplyId } : {}),
    };
    return { intent, command };
  }

  async #sendPreparedDelivery(prepared: PreparedDelivery): Promise<void> {
    const { intent, command } = prepared;
    const { message, target, cards } = intent;
    try {
      await this.#commandBus.sendToNode(target.nodeId, 'message.deliver', command);
      await this.#log(message.traceId, 'info', 'delivery_queued', {
        taskId: command.taskId,
        target: {
          nodeId: target.nodeId,
          platform: target.platform,
          sessionId: target.id,
          externalId: target.externalId,
        },
        cardCount: cards.length,
        replyMessageId: command.replyMessageId,
      });
    } catch (error) {
      await this.#store.set('delivery-task', command.taskId, {
        ...(await this.#store.get<Record<string, unknown>>('delivery-task', command.taskId))?.value,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString(),
      });
      await this.#log(message.traceId, 'error', 'delivery_command_failed', {
        taskId: command.taskId,
        targetSessionId: target.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #dispatchDeliveryBatch(intents: readonly DeliveryIntent[]): Promise<void> {
    if (!intents.length) return;
    const prepared = await Promise.all(intents.map((intent) => this.#prepareDelivery(intent)));
    const byNode = new Map<string, PreparedDelivery[]>();
    for (const item of prepared) {
      const list = byNode.get(item.intent.target.nodeId) ?? [];
      list.push(item);
      byNode.set(item.intent.target.nodeId, list);
    }
    await Promise.all(
      [...byNode.entries()].map(async ([nodeId, deliveries]) => {
        const chunks: PreparedDelivery[][] = [];
        let current: PreparedDelivery[] = [];
        for (const delivery of deliveries) {
          const candidate = [...current, delivery];
          const size = Buffer.byteLength(
            JSON.stringify({ deliveries: candidate.map(({ command }) => command) }),
            'utf8',
          );
          if (current.length && size > MAX_DELIVERY_BATCH_BYTES) {
            chunks.push(current);
            current = [delivery];
          } else {
            current = candidate;
          }
        }
        if (current.length) chunks.push(current);

        // Chunks for the same node are sent serially so a large batch cannot
        // overtake an earlier chunk on the WebSocket.
        for (const chunk of chunks) {
          const payload = { batchId: randomUUID(), deliveries: chunk.map(({ command }) => command) };
          try {
            await this.#commandBus.sendToNode(nodeId, 'message.deliver.batch', payload);
            for (const { intent, command } of chunk) {
              await this.#log(intent.message.traceId, 'info', 'delivery_queued', {
                taskId: command.taskId,
                batchId: payload.batchId,
                target: {
                  nodeId,
                  platform: intent.target.platform,
                  sessionId: intent.target.id,
                  externalId: intent.target.externalId,
                },
                cardCount: intent.cards.length,
                replyMessageId: command.replyMessageId,
              });
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            for (const { intent, command } of chunk) {
              await this.#store.set('delivery-task', command.taskId, {
                ...(await this.#store.get<Record<string, unknown>>('delivery-task', command.taskId))?.value,
                status: 'failed',
                error: message,
                updatedAt: new Date().toISOString(),
              });
              await this.#log(intent.message.traceId, 'error', 'delivery_command_failed', {
                taskId: command.taskId,
                batchId: payload.batchId,
                targetSessionId: intent.target.id,
                error: message,
              });
            }
          }
        }
      }),
    );
  }

  async handleReview(taskId: string, decision: 'approve' | 'reject'): Promise<void> {
    const entry = await this.#store.get<ManualReviewRecord | Record<string, unknown>>(
      'moderation-review',
      taskId,
    );
    if (!entry) throw new Error('Moderation review not found.');
    const value = entry.value;
    if (!('reviewNodeId' in value) || !('blueprintId' in value)) {
      await this.#store.set('moderation-review', taskId, {
        ...value,
        status: decision === 'approve' ? 'approved' : 'rejected',
        resolvedAt: new Date().toISOString(),
        note: '旧版人工审核记录已处理，无法恢复旧版流水线。',
      });
      return;
    }
    const review = value as ManualReviewRecord;
    if (review.status !== 'pending') throw new Error('Review has already been resolved.');
    await this.#store.set('moderation-review', taskId, { ...review, status: 'processing' });
    try {
      const blueprintEntry = await this.#store.get<BlueprintVersion>(
        'blueprint-version',
        `${review.blueprintId}:${review.blueprintVersion}`,
      );
      if (!blueprintEntry) throw new Error('Blueprint version no longer exists.');
      const sessions = (await this.#store.list<ChatSession>('chat-session'))
        .map((item) => chatSessionSchema.parse(item.value))
        .filter((session) => session.status === 'verified');
      const sourceSession =
        review.sourceSession ?? sessions.find((session) => session.id === review.sourceSessionId);
      if (!sourceSession) throw new Error('Source chat session is no longer verified.');
      const chosenHandle = decision === 'approve' ? 'passed' : 'blocked';
      const initialWork = blueprintEntry.value.edges
        .filter(
          (edge) => edge.sourceNodeId === review.reviewNodeId && edge.sourceHandle === chosenHandle,
        )
        .map((edge) => ({ nodeId: edge.targetNodeId, state: review.state }));
      await this.#log(review.traceId, 'info', 'manual_review_resolved', {
        taskId,
        decision,
        selectedOutput: chosenHandle,
      });
      await this.#executeBlueprint(
        blueprintEntry.value,
        sourceSession,
        sessions,
        review.message,
        review.recentMessages,
        initialWork,
      );
      await this.#store.set('moderation-review', taskId, {
        ...review,
        status: decision === 'approve' ? 'approved' : 'rejected',
        resolvedAt: new Date().toISOString(),
      });
    } catch (error) {
      await this.#store.set('moderation-review', taskId, {
        ...review,
        status: 'pending',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async #handleDelivered(payload: unknown): Promise<void> {
    const delivered = deliveredFrameSchema.parse(payload);
    await this.#store.set(
      'reply-mapping',
      mappingKey(delivered.sourceSessionId, delivered.sourceMessageId, delivered.targetSessionId),
      { targetMessageId: delivered.targetMessageId, createdAt: new Date().toISOString() },
    );
    const task = await this.#store.get<Record<string, unknown>>('delivery-task', delivered.taskId);
    if (task) {
      await this.#store.set('delivery-task', delivered.taskId, {
        ...task.value,
        status: 'acknowledged',
        targetMessageId: delivered.targetMessageId,
        updatedAt: new Date().toISOString(),
      });
      await this.#log(String(task.value.traceId), 'info', 'delivery_succeeded', {
        ...delivered,
      });
    }
  }

  async #handleDeliveryFailed(payload: unknown): Promise<void> {
    const failed = deliveryFailedFrameSchema.parse(payload);
    const task = await this.#store.get<Record<string, unknown>>('delivery-task', failed.taskId);
    if (task) {
      await this.#store.set('delivery-task', failed.taskId, {
        ...task.value,
        status: 'failed',
        error: failed.error,
        updatedAt: new Date().toISOString(),
      });
      await this.#log(String(task.value.traceId), 'error', 'delivery_failed', failed);
    }
  }

  async #recentMessages(sessionId: string): Promise<readonly MessageEnvelope[]> {
    const entries = await this.#store.list<{ sessionId: string; message: MessageEnvelope }>(
      'message-history',
    );
    return entries
      .filter((entry) => entry.value.sessionId === sessionId)
      .slice(0, 5)
      .map((entry) => messageEnvelopeSchema.parse(entry.value.message))
      .reverse();
  }

  async #log(traceId: string, level: LogLevel, event: string, details: unknown): Promise<void> {
    await this.#store.set('trace-log', randomUUID(), {
      id: randomUUID(),
      traceId,
      level,
      event,
      details,
      createdAt: new Date().toISOString(),
    });
  }
}

export class CentralMessageProcessor implements MessageProcessor {
  readonly #store: StateStore;
  readonly #secrets: SecretStore;

  constructor(store: StateStore, secrets: SecretStore) {
    this.#store = store;
    this.#secrets = secrets;
  }

  async process(message: MessageEnvelope, target: ChatSession): Promise<ProcessingResult> {
    return {
      decision: 'allow',
      cards: await this.render(message, target, message.text ?? '', false),
    };
  }

  async processApproved(message: MessageEnvelope, target: ChatSession): Promise<ProcessingResult> {
    return await this.process(message, target);
  }

  async translate(
    message: MessageEnvelope,
    target: ChatSession,
    text: string,
    prompt: string,
    recentMessages: readonly MessageEnvelope[],
    memoryMode: boolean,
  ): Promise<TranslationResult> {
    const { settings, client } = await this.#client();
    return await new LlmTranslationService(client).translate({
      text,
      targetLanguage: target.platform === 'discord' ? 'en' : 'zh',
      model: settings.translationModel,
      prompt: { content: prompt, version: 1 },
      ...(memoryMode
        ? {
            recentMessages: recentMessages
              .filter((item) => item.text?.trim())
              .slice(-5)
              .map((item) => ({ sender: item.sender.displayName, text: item.text! })),
            ...(message.replyTo?.textPreview
              ? {
                  repliedMessage: {
                    sender: message.replyTo.senderDisplayName,
                    text: message.replyTo.textPreview,
                  },
                }
              : {}),
          }
        : {}),
    });
  }

  async moderate(
    text: string,
    prompt: string,
    options?: {
      readonly imageReviewRequested?: boolean;
      readonly imageCount?: number;
      readonly imageUrls?: readonly string[];
    },
  ): Promise<ViolationAssessment> {
    const unavailable = (
      reason: string,
      diagnostics?: Record<string, unknown>,
    ): ViolationAssessment => ({
      violationScore: 1,
      categories: ['image-review-unavailable'],
      reason,
      confidence: 1,
      model: 'image-review-unavailable',
      ...(diagnostics ? { diagnostics } : {}),
    });
    if (!options?.imageReviewRequested) {
      const { settings, client } = await this.#client();
      return await new LlmModerationService(client).moderate({
        text,
        model: settings.moderationModel,
        prompt: { content: prompt, version: 1 },
      });
    }

    let settings: z.infer<typeof llmSettingsSchema>;
    let client: OpenAICompatibleClient;
    try {
      const connection = await this.#client();
      settings = connection.settings;
      client = connection.client;
    } catch (error) {
      return unavailable('图片审核配置或模型客户端不可用。', {
        error: describeError(error),
      });
    }
    if (!settings.imageModerationModel.trim()) {
      return unavailable('未配置图片审核模型，无法审核图片。');
    }
    const imageUrls = options.imageUrls ?? [];
    if (
      !imageUrls.length ||
      imageUrls.length !== options.imageCount ||
      imageUrls.length > settings.maxImageCount
    ) {
      return unavailable('图片地址缺失或图片数量超过审核限制，无法审核图片。');
    }

    let images: string[];
    try {
      images = await Promise.all(
        imageUrls.map(
          async (url) =>
            (
              await downloadExternalImage(url, {
                maxBytes: settings.maxImageBytes,
              })
            ).dataUri,
        ),
      );
    } catch (error) {
      return unavailable('图片下载或解码失败，无法审核图片。', {
        error: describeError(error),
      });
    }

    try {
      return await new LlmModerationService(client).moderate({
        text,
        model: settings.imageModerationModel,
        prompt: { content: prompt, version: 1 },
        images,
        imageDetail: settings.imageModerationDetail,
      });
    } catch (error) {
      return unavailable('图片审核模型不支持视觉输入或请求失败。', {
        error: describeError(error),
      });
    }
  }

  async render(
    message: MessageEnvelope,
    target: ChatSession,
    text: string,
    fixedText: boolean,
  ): Promise<readonly Buffer[]> {
    const avatar = message.sender.avatarUrl
      ? await downloadExternalImage(message.sender.avatarUrl).catch(() => undefined)
      : undefined;
    const replyImage = message.replyTo?.imagePreview?.sourceUrl
      ? await downloadExternalImage(message.replyTo.imagePreview.sourceUrl).catch(() => undefined)
      : undefined;
    const images = (
      await Promise.all(
        message.attachments.map(async (attachment) =>
          attachment.sourceUrl
            ? await downloadExternalImage(attachment.sourceUrl).catch(() => undefined)
            : undefined,
        ),
      )
    )
      .filter((image): image is NonNullable<typeof image> => Boolean(image))
      .map((image) => image.dataUri);
    const input: MessageCardInput = {
      sourcePlatform: message.source.platform,
      targetLanguage: target.platform === 'discord' ? 'en' : 'zh',
      sourceName: message.source.channelId,
      senderName: message.sender.displayName,
      ...(avatar ? { senderAvatar: avatar.dataUri } : {}),
      sentAt: message.sentAt,
      primaryText: text,
      ...(!fixedText && message.text ? { originalText: message.text } : {}),
      images,
      ...(message.replyTo
        ? {
            reply: {
              senderName: message.replyTo.senderDisplayName,
              ...(message.replyTo.textPreview ? { textPreview: message.replyTo.textPreview } : {}),
              ...(replyImage ? { imagePreview: replyImage.dataUri } : {}),
            },
          }
        : {}),
      ...(!fixedText && message.unsupportedType
        ? { unsupportedType: message.unsupportedType }
        : {}),
      traceLabel: message.traceId.slice(0, 8),
    };
    return await renderMessageCards(input);
  }

  async #client(): Promise<{
    settings: z.infer<typeof llmSettingsSchema>;
    apiKey: string;
    client: OpenAICompatibleClient;
  }> {
    const settingsEntry = await this.#store.get('settings', 'llm');
    const apiKey = await this.#secrets.get('llm-api-key');
    if (!settingsEntry || !apiKey) throw new Error('大模型 API 设置或密钥尚未配置。');
    const settings = llmSettingsSchema.parse(settingsEntry.value);
    return {
      settings,
      apiKey,
      client: new OpenAICompatibleClient({
        baseUrl: settings.baseUrl,
        apiKey,
        timeoutMs: settings.timeoutMs,
        maxRetries: settings.maxRetries,
      }),
    };
  }
}

function mappingKey(
  sourceSessionId: string,
  sourceMessageId: string,
  targetSessionId: string,
): string {
  return `${sourceSessionId}:${sourceMessageId}:${targetSessionId}`;
}
