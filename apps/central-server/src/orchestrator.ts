import { randomUUID } from 'node:crypto';

import { validateBlueprint } from '@disqord/blueprint';
import { AvatarCache, downloadExternalImage, renderMessageCards } from '@disqord/card-renderer';
import {
  LlmModerationService,
  LlmTranslationService,
  OpenAICompatibleClient,
  getLlmFailureDetails,
  llmSettingsSchema,
  type LlmFailureDetails,
  type LlmProviderSettings,
  type ViolationAssessment,
} from '@disqord/llm';
import {
  avatarKeySchema,
  avatarRequestSchema,
  blueprintVersionSchema,
  blueprintSchema,
  cardSettingsSchema,
  chatSessionSchema,
  createAvatarKey,
  createMessageIdempotencyKey,
  messageEnvelopeSchema,
  type MessageCardRenderSpec,
  messageUploadBatchSchema,
  type Blueprint,
  type BlueprintEdge,
  type BlueprintNode,
  type BlueprintVersion,
  type ChatSession,
  type MessageEnvelope,
  type MessageUploadBatch,
  type TranslationResult,
} from '@disqord/shared';
import { type ReceivedNodeFrame } from '@disqord/transport';
import { z } from 'zod';

import { resolveNodeRuntimeSettings } from './runtime-settings.js';
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

const chatConfigSchema = z.object({
  sessionId: z.uuid(),
  /** Whether messages produced by this bot's own account are forwarded. */
  includeSelf: z.boolean().default(false),
});
const translationConfigSchema = z.object({
  prompt: z.string().trim().min(1).max(50_000),
  memoryMode: z.boolean().default(false),
  enableThinking: z.boolean().default(false),
});
const moderationConfigSchema = z.object({
  prompt: z.string().trim().min(1).max(50_000),
  threshold: z.number().min(0).max(1),
  enableThinking: z.boolean().default(false),
});
const fixedTextConfigSchema = z.object({ text: z.string().max(30_000) });
const MAX_DELIVERY_BATCH_BYTES = 6 * 1024 * 1024;
const MESSAGE_UPLOAD_BATCH_NAMESPACE = 'message-upload-batch';
const AVATAR_SOURCE_NAMESPACE = 'avatar-source';
const MAX_MESSAGE_UPLOAD_BATCH_ATTEMPTS = 3;

const avatarSourceRecordSchema = z.object({ sourceUrl: z.url() });

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function describeError(error: unknown): Record<string, unknown> {
  const base: Record<string, unknown> = {
    name: error instanceof Error ? error.name : 'UnknownError',
    message: error instanceof Error ? error.message : String(error),
  };
  if (error instanceof Error && error.stack) base.stack = error.stack.slice(0, 12_000);
  const llm = getLlmFailureDetails(error);
  if (llm) base.llm = llm;
  if (error instanceof AggregateError) {
    base.causes = error.errors.slice(0, 12).map((cause) => describeError(cause));
  }
  return base;
}

function firstLlmFailure(error: unknown): LlmFailureDetails | undefined {
  const direct = getLlmFailureDetails(error);
  if (direct) return direct;
  if (error instanceof AggregateError) {
    for (const cause of error.errors) {
      const nested = firstLlmFailure(cause);
      if (nested) return nested;
    }
  }
  return undefined;
}

function processingFailureText(
  stage: 'translation' | 'moderation' | 'rendering',
  traceId: string,
  error: unknown,
): string {
  const label = stage === 'translation' ? '翻译' : stage === 'moderation' ? '内容审核' : '卡片渲染';
  const failure = firstLlmFailure(error);
  const reason =
    failure?.status === 401 || failure?.status === 403
      ? '模型密钥无效或没有访问权限'
      : failure?.status === 402
        ? '模型账户余额或额度不足'
        : failure?.status === 429
          ? '模型服务额度耗尽或请求过于频繁'
          : failure?.stage === 'network'
            ? '模型服务暂时无法连接'
            : stage === 'rendering'
              ? '渲染组件暂时不可用'
              : '所有已启用的模型配置均处理失败';
  return `【DisQord ${label}异常】${reason}。原消息已继续转发，请联系管理员并提供追踪号 ${traceId.slice(0, 8)}。`;
}

class LlmProviderChainError extends AggregateError {
  constructor(operation: string, errors: readonly Error[]) {
    super(errors, `${operation} failed on every enabled LLM provider.`);
    this.name = 'LlmProviderChainError';
  }
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
    enableThinking: boolean,
  ): Promise<TranslationResult>;
  moderate?(
    text: string,
    prompt: string,
    options?: {
      readonly imageReviewRequested?: boolean;
      readonly imageCount?: number;
      readonly imageUrls?: readonly string[];
      readonly enableThinking?: boolean;
    },
  ): Promise<ViolationAssessment>;
  render?(
    message: MessageEnvelope,
    target: ChatSession,
    text: string,
    fixedText: boolean,
  ): Promise<readonly Buffer[]>;
  /** Build a compact client-side render request. No final PNG is produced. */
  prepareRender?(
    message: MessageEnvelope,
    target: ChatSession,
    text: string,
    fixedText: boolean,
  ): Promise<MessageCardRenderSpec>;
  resolveAvatar?(avatarKey: string): Promise<string | undefined>;
}

interface PipelineState {
  readonly text: string;
  readonly fixedText: boolean;
  readonly cards?: readonly Buffer[];
  readonly renderSpec?: MessageCardRenderSpec;
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
  readonly cards?: readonly Buffer[];
  readonly renderSpec?: MessageCardRenderSpec;
  readonly processedText: string;
  readonly fastMode: boolean;
}

interface OutboundDeliveryCommand {
  readonly taskId: string;
  readonly sourceSessionId: string;
  readonly sourceMessageId: string;
  readonly targetSessionId: string;
  readonly externalId: string;
  readonly mode: 'card' | 'text';
  readonly cards: readonly string[];
  readonly render?: MessageCardRenderSpec;
  readonly text?: string;
  readonly senderName?: string;
  readonly fastMode?: boolean;
  readonly replyMessageId?: string;
  /** System error notice; the target node never re-uploads its platform message. */
  readonly errorNotice?: boolean;
}

interface PreparedDelivery {
  readonly intent: DeliveryIntent;
  readonly command: OutboundDeliveryCommand;
}

interface MessageUploadBatchRecord {
  readonly batchId: string;
  readonly frameId: string;
  readonly nodeId: string;
  readonly nodeType: ReceivedNodeFrame['nodeType'];
  readonly messages: MessageUploadBatch['messages'];
  readonly status: 'queued' | 'processing' | 'completed' | 'failed';
  readonly attempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastError?: Record<string, unknown>;
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

interface ActivityBatchContext {
  readonly batchId: string;
  readonly batchIndex: number;
  readonly batchSize: number;
}

type BlueprintActivityDetail = Pick<
  BlueprintActivityRecord,
  'message' | 'text' | 'violationScore' | 'route'
> &
  Partial<Pick<BlueprintActivityRecord, 'phase'>>;

interface BlueprintActivityRecord {
  readonly id: string;
  readonly blueprintId: string;
  readonly version: number;
  readonly traceId: string;
  readonly batchId?: string;
  readonly batchIndex?: number;
  readonly batchSize?: number;
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
  readonly #messageBatchWorkers = new Map<string, Promise<void>>();
  readonly #messageBatchRetryTimers = new Map<string, NodeJS.Timeout>();
  #activitySequence = 0;

  constructor(store: StateStore, commandBus: NodeCommandBus, processor: MessageProcessor) {
    this.#store = store;
    this.#commandBus = commandBus;
    this.#processor = processor;
    // Batch uploads are acknowledged only after this durable record is written,
    // so a slow LLM call cannot make the node retransmit the same batch.  Any
    // record left behind by a central restart is resumed in the background.
    void this.#recoverMessageUploadBatches().catch((error: unknown) => {
      console.error('[DisQord/Central] failed to recover message upload batches', error);
    });
  }

  async handleNodeFrame(frame: ReceivedNodeFrame): Promise<void> {
    if (frame.kind === 'message.upload') {
      // A single upload is still acknowledged after the durable batch record
      // is written.  Processing must never hold the transport frame open
      // while translation, moderation, rendering, or delivery is running.
      const message = messageEnvelopeSchema.parse(frame.payload);
      await this.#acceptMessageUploadBatch({
        ...frame,
        kind: 'message.upload.batch',
        payload: { batchId: frame.frameId, messages: [message] },
      });
    } else if (frame.kind === 'message.upload.batch') {
      await this.#acceptMessageUploadBatch(frame);
    } else if (frame.kind === 'node.runtime.settings.request') {
      await this.#sendRuntimeSettings(frame.nodeId);
    } else if (frame.kind === 'avatar.request') {
      await this.#handleAvatarRequest(frame);
    } else if (frame.kind === 'message.delivered') {
      await this.#handleDelivered(frame.payload);
    } else if (frame.kind === 'message.delivery_failed') {
      await this.#handleDeliveryFailed(frame.payload);
    } else if (frame.kind === 'session.candidates') {
      await this.#store.set('session-candidates', frame.nodeId, frame.payload);
      await this.#reconcileSessionDisplayNames(frame.nodeId, frame.payload);
    }
  }

  /**
   * Self-healing session names: a session created before the node announced
   * its candidate list keeps the numeric fallback name ("Discord <server> /
   * <channel>"). When the real candidate later arrives, promote the resolved
   * display name so the web UI shows the channel name without re-creating it.
   */
  async #reconcileSessionDisplayNames(nodeId: string, payload: unknown): Promise<void> {
    const parsed = z
      .object({
        candidates: z.array(
          z.object({
            externalId: z.string().min(1).max(256),
            spaceId: z.string().min(1).max(256),
            displayName: z.string().trim().min(1).max(256),
          }),
        ),
      })
      .safeParse(payload);
    if (!parsed.success) return;
    for (const candidate of parsed.data.candidates) {
      const sessions = (await this.#store.list<ChatSession>('chat-session'))
        .map((entry) => chatSessionSchema.parse(entry.value))
        .filter(
          (session) =>
            session.nodeId === nodeId &&
            session.externalId === candidate.externalId &&
            session.spaceId === candidate.spaceId &&
            isFallbackSessionName(session.displayName),
        );
      for (const session of sessions) {
        await this.#store.set('chat-session', session.id, {
          ...session,
          displayName: candidate.displayName,
          updatedAt: new Date().toISOString(),
        });
      }
    }
  }

  async #sendRuntimeSettings(nodeId: string): Promise<void> {
    await this.#commandBus.sendToNode(
      nodeId,
      'node.runtime.settings',
      await resolveNodeRuntimeSettings(this.#store, nodeId),
    );
  }

  async #handleAvatarRequest(frame: ReceivedNodeFrame): Promise<void> {
    const request = avatarRequestSchema.parse(frame.payload);
    const dataUri = this.#processor.resolveAvatar
      ? await this.#processor.resolveAvatar(request.avatarKey)
      : undefined;
    await this.#commandBus.sendToNode(frame.nodeId, 'avatar.response', {
      requestId: request.requestId,
      avatarKey: request.avatarKey,
      ...(dataUri ? { dataUri } : {}),
    });
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
          config.enableThinking,
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
          ? await this.#processor.moderate(state.text, config.prompt, {
              enableThinking: config.enableThinking,
            })
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
        undefined,
        { batchId: traceId, batchIndex: 0, batchSize: 1 },
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
    activityBatch?: ActivityBatchContext,
    fastMode = false,
  ): Promise<void> {
    const message = messageEnvelopeSchema.parse(messagePayload);
    const batchContext: ActivityBatchContext = activityBatch ?? {
      batchId: message.eventId,
      batchIndex: 0,
      batchSize: 1,
    };
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
          batchContext,
          fastMode,
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

  /**
   * Accept a coalesced upload quickly enough for the node's frame
   * acknowledgement window.  The central server stores the complete batch
   * before returning; processing and delivery happen in a worker afterwards.
   * This is deliberately one durable command, not one command per message.
   */
  async #acceptMessageUploadBatch(frame: ReceivedNodeFrame): Promise<void> {
    const batch = messageUploadBatchSchema.parse(frame.payload);
    const verifiedSessions = (await this.#store.list<ChatSession>('chat-session'))
      .map((entry) => chatSessionSchema.parse(entry.value))
      .filter((session) => session.status === 'verified');
    // An unbound channel is intentionally invisible to the operational log.
    // Filter it before creating the durable batch record so unmatched traffic
    // cannot produce noisy `message_upload_*` entries or occupy the queue.
    const acceptedMessages = batch.messages.filter((message) =>
      verifiedSessions.some(
        (session) =>
          session.nodeId === frame.nodeId &&
          session.platform === frame.nodeType &&
          session.externalId === message.source.channelId,
      ),
    );
    if (!acceptedMessages.length) return;
    const acceptedBatch = { ...batch, messages: acceptedMessages };
    const batchId = batch.batchId ?? frame.frameId;
    const existing = await this.#store.get<MessageUploadBatchRecord>(
      MESSAGE_UPLOAD_BATCH_NAMESPACE,
      batchId,
    );
    if (existing?.value.status === 'completed') {
      await this.#log(batch.messages[0]!.traceId, 'debug', 'message_upload_batch_deduplicated', {
        batchId,
        frameId: frame.frameId,
        batchSize: batch.messages.length,
      });
      return;
    }
    if (existing?.value.status === 'processing' || existing?.value.status === 'queued') {
      // A retry can arrive after the socket was interrupted.  The original
      // record is authoritative; never replace its message order with a
      // potentially different payload carrying the same batch id.
      this.#queueMessageUploadBatch(batchId);
      await this.#log(batch.messages[0]!.traceId, 'debug', 'message_upload_batch_deduplicated', {
        batchId,
        frameId: frame.frameId,
        batchSize: existing.value.messages.length,
        status: existing.value.status,
      });
      return;
    }
    if (existing && existing.value.attempts >= MAX_MESSAGE_UPLOAD_BATCH_ATTEMPTS) {
      await this.#log(batch.messages[0]!.traceId, 'warn', 'message_upload_batch_retry_exhausted', {
        batchId,
        attempts: existing.value.attempts,
      });
      return;
    }

    const now = new Date().toISOString();
    const record: MessageUploadBatchRecord = {
      batchId,
      frameId: existing?.value.frameId ?? frame.frameId,
      nodeId: existing?.value.nodeId ?? frame.nodeId,
      nodeType: existing?.value.nodeType ?? frame.nodeType,
      messages: existing?.value.messages ?? acceptedBatch.messages,
      status: 'queued',
      attempts: existing?.value.attempts ?? 0,
      createdAt: existing?.value.createdAt ?? now,
      updatedAt: now,
      ...(existing?.value.lastError ? { lastError: existing.value.lastError } : {}),
    };
    await this.#store.set(MESSAGE_UPLOAD_BATCH_NAMESPACE, batchId, record);
    await this.#log(record.messages[0]!.traceId, 'info', 'message_upload_batch_accepted', {
      batchId,
      frameId: record.frameId,
      nodeId: record.nodeId,
      nodeType: record.nodeType,
      batchSize: record.messages.length,
      eventIds: record.messages.map((message) => message.eventId),
    });
    await this.#store.flush();
    this.#queueMessageUploadBatch(batchId);
  }

  #queueMessageUploadBatch(batchId: string): void {
    if (this.#messageBatchWorkers.has(batchId)) return;
    const worker = this.#processMessageUploadBatch(batchId).finally(() => {
      this.#messageBatchWorkers.delete(batchId);
    });
    this.#messageBatchWorkers.set(batchId, worker);
    void worker.catch((error: unknown) => {
      // The worker persists its failure state.  Keep this guard so a storage
      // error cannot become an unhandled rejection and kill the node process.
      console.error(`[DisQord/Central] message upload batch ${batchId} failed`, error);
    });
  }

  async #processMessageUploadBatch(batchId: string): Promise<void> {
    const entry = await this.#store.get<MessageUploadBatchRecord>(
      MESSAGE_UPLOAD_BATCH_NAMESPACE,
      batchId,
    );
    if (!entry || entry.value.status === 'completed') return;
    if (entry.value.attempts >= MAX_MESSAGE_UPLOAD_BATCH_ATTEMPTS) {
      if (entry.value.status !== 'failed') {
        await this.#store.set(MESSAGE_UPLOAD_BATCH_NAMESPACE, batchId, {
          ...entry.value,
          status: 'failed',
          updatedAt: new Date().toISOString(),
        });
      }
      return;
    }

    const processing: MessageUploadBatchRecord = {
      ...entry.value,
      status: 'processing',
      attempts: entry.value.attempts + 1,
      updatedAt: new Date().toISOString(),
    };
    await this.#store.set(MESSAGE_UPLOAD_BATCH_NAMESPACE, batchId, processing);
    await this.#log(processing.messages[0]!.traceId, 'debug', 'message_upload_batch_processing', {
      batchId,
      attempt: processing.attempts,
      batchSize: processing.messages.length,
    });

    const frame: ReceivedNodeFrame = {
      nodeId: processing.nodeId,
      nodeType: processing.nodeType,
      kind: 'message.upload.batch',
      frameId: processing.frameId,
      payload: { batchId: processing.batchId, messages: processing.messages },
    };
    try {
      await this.#handleMessageUploadBatch(frame);
      await this.#store.set(MESSAGE_UPLOAD_BATCH_NAMESPACE, batchId, {
        ...processing,
        status: 'completed',
        updatedAt: new Date().toISOString(),
      } satisfies MessageUploadBatchRecord);
      await this.#log(processing.messages[0]!.traceId, 'info', 'message_upload_batch_completed', {
        batchId,
        attempt: processing.attempts,
        batchSize: processing.messages.length,
      });
    } catch (error) {
      const lastError = describeError(error);
      const failed = {
        ...processing,
        status:
          processing.attempts < MAX_MESSAGE_UPLOAD_BATCH_ATTEMPTS
            ? ('queued' as const)
            : ('failed' as const),
        updatedAt: new Date().toISOString(),
        lastError,
      } satisfies MessageUploadBatchRecord;
      await this.#store.set(MESSAGE_UPLOAD_BATCH_NAMESPACE, batchId, failed);
      await this.#log(
        processing.messages[0]!.traceId,
        processing.attempts < MAX_MESSAGE_UPLOAD_BATCH_ATTEMPTS ? 'warn' : 'error',
        processing.attempts < MAX_MESSAGE_UPLOAD_BATCH_ATTEMPTS
          ? 'message_upload_batch_retry_scheduled'
          : 'message_upload_batch_failed',
        {
          batchId,
          attempt: processing.attempts,
          nextAttempt:
            processing.attempts < MAX_MESSAGE_UPLOAD_BATCH_ATTEMPTS
              ? processing.attempts + 1
              : undefined,
          error: lastError,
        },
      );
      if (processing.attempts < MAX_MESSAGE_UPLOAD_BATCH_ATTEMPTS) {
        this.#scheduleMessageUploadBatchRetry(batchId, processing.attempts);
      }
    }
  }

  #scheduleMessageUploadBatchRetry(batchId: string, attempt: number): void {
    if (this.#messageBatchRetryTimers.has(batchId)) return;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt - 1));
    const timer = setTimeout(() => {
      this.#messageBatchRetryTimers.delete(batchId);
      this.#queueMessageUploadBatch(batchId);
    }, delay);
    timer.unref();
    this.#messageBatchRetryTimers.set(batchId, timer);
  }

  async #recoverMessageUploadBatches(): Promise<void> {
    const entries = await this.#store.list<MessageUploadBatchRecord>(
      MESSAGE_UPLOAD_BATCH_NAMESPACE,
    );
    for (const entry of entries) {
      const record = entry.value;
      if (record.status === 'completed' || record.attempts >= MAX_MESSAGE_UPLOAD_BATCH_ATTEMPTS) {
        continue;
      }
      if (record.status === 'processing') {
        await this.#store.set(MESSAGE_UPLOAD_BATCH_NAMESPACE, record.batchId, {
          ...record,
          status: 'queued',
          updatedAt: new Date().toISOString(),
        } satisfies MessageUploadBatchRecord);
      }
      this.#queueMessageUploadBatch(record.batchId);
    }
  }

  async #handleMessageUploadBatch(frame: ReceivedNodeFrame): Promise<void> {
    const batch = messageUploadBatchSchema.parse(frame.payload);
    const messages = batch.messages;
    const collectors = messages.map(() => [] as DeliveryIntent[]);
    const concurrency = await this.#configuredLlmConcurrency();
    const fastMode = await this.#fastMode();
    let nextIndex = 0;
    const failures: { index: number; error: unknown }[] = [];
    const worker = async (): Promise<void> => {
      while (true) {
        const index = nextIndex++;
        if (index >= messages.length) return;
        try {
          await this.#handleMessageUpload(
            frame,
            messages[index],
            collectors[index],
            true,
            {
              batchId: batch.batchId ?? frame.frameId,
              batchIndex: index,
              batchSize: messages.length,
            },
            fastMode,
          );
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
    await this.#store.flush();
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

  async #fastMode(): Promise<boolean> {
    const entry = await this.#store.get('settings', 'llm');
    if (!entry) return false;
    const parsed = llmSettingsSchema.safeParse(entry.value);
    return parsed.success ? parsed.data.fastMode : false;
  }

  async #executeBlueprint(
    blueprint: BlueprintVersion,
    sourceSession: ChatSession,
    sessions: readonly ChatSession[],
    message: MessageEnvelope,
    recentMessages: readonly MessageEnvelope[],
    initialWork?: readonly WorkItem[],
    deliveryCollector?: DeliveryIntent[],
    activityBatch?: ActivityBatchContext,
    fastMode = false,
  ): Promise<{ paused: boolean }> {
    let bridgeReplyOriginalText: string | undefined;
    let bridgeReplyOriginalAttachments: MessageEnvelope['attachments'] = [];
    const reply = message.replyTo;
    const bridgeReplyOriginal = await this.#resolveBridgeReply(sourceSession, sessions, reply);
    if (reply && bridgeReplyOriginal) {
      bridgeReplyOriginalText = bridgeReplyOriginal.text?.trim() || undefined;
      bridgeReplyOriginalAttachments = bridgeReplyOriginal.attachments;
      message = {
        ...message,
        replyTo: {
          sourceMessageId: reply.sourceMessageId,
          ...(reply.targetMessageId ? { targetMessageId: reply.targetMessageId } : {}),
          ...(bridgeReplyOriginal.sender.id ? { senderId: bridgeReplyOriginal.sender.id } : {}),
          senderDisplayName: bridgeReplyOriginal.sender.displayName,
          ...(bridgeReplyOriginal.text?.trim()
            ? { textPreview: bridgeReplyOriginal.text.slice(0, 1000) }
            : {}),
          ...(bridgeReplyOriginal.customEmojis?.length
            ? { customEmojis: bridgeReplyOriginal.customEmojis }
            : {}),
        },
      };
    }

    const nodes = new Map(blueprint.nodes.map((node) => [node.id, node]));
    const outgoing = new Map<string, BlueprintEdge[]>();
    for (const edge of blueprint.edges) {
      const current = outgoing.get(edge.sourceNodeId) ?? [];
      current.push(edge);
      outgoing.set(edge.sourceNodeId, current);
    }
    const starts = blueprint.nodes.filter((node) => {
      if (node.type !== 'chat-input') return false;
      const config = chatConfigSchema.parse(node.config);
      if (config.sessionId !== sourceSession.id) return false;
      if (message.fromSelf && !config.includeSelf) return false;
      return true;
    });
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
      ...bridgeReplyOriginalAttachments,
      ...(message.replyTo?.imagePreview ? [message.replyTo.imagePreview] : []),
    ];
    const moderationOptions = moderationImageRefs.length
      ? {
          imageReviewRequested: true,
          imageCount: moderationImageRefs.length,
          // Speed mode never downloads media.  Keeping the image-review flag
          // with an empty URL list makes the moderation service fail closed
          // instead of silently approving an unreviewed image.
          imageUrls: fastMode
            ? []
            : moderationImageRefs.flatMap((image) => (image.sourceUrl ? [image.sourceUrl] : [])),
        }
      : undefined;
    const recordActivity = (
      node: BlueprintNode,
      step: number,
      detail: BlueprintActivityDetail,
    ): Promise<void> => this.#recordActivity(blueprint, message, node, step, detail, activityBatch);

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
      await recordActivity(node, processedSteps, {
        phase: 'entered',
        message: '消息已到达，准备运行此节点',
        text: state.text,
      });

      if (node.type === 'chat-input' || node.type === 'simulated-input') {
        await recordActivity(node, processedSteps, {
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
        let result: TranslationResult | undefined;
        try {
          result = await this.#processor.translate(
            message,
            target,
            state.text,
            config.prompt,
            recentMessages,
            config.memoryMode,
            config.enableThinking,
          );
        } catch (error) {
          const errorDetails = describeError(error);
          await this.#log(message.traceId, 'error', 'translation_failed', {
            nodeId: node.id,
            modelTarget: target.platform === 'discord' ? 'en' : 'zh',
            inputText: state.text,
            error: errorDetails,
          });
          const llm = firstLlmFailure(error);
          if (llm) {
            await this.#log(message.traceId, 'error', 'llm_request_failed', {
              nodeId: node.id,
              nodeType: node.type,
              operation: 'translation',
              failure: llm,
            });
          }
          state = {
            ...state,
            text: processingFailureText('translation', message.traceId, error),
            fixedText: false,
          };
          await recordActivity(node, processedSteps, {
            message: '翻译失败；已换成用户可见的错误说明并继续流程',
            text: state.text,
          });
        }
        if (result) {
          await this.#log(message.traceId, 'info', 'translation_response', {
            nodeId: node.id,
            rawResult: result,
          });
          state = { ...state, text: result.translatedText, fixedText: false };
          await recordActivity(node, processedSteps, {
            message: `翻译结果：${result.translatedText}`,
            text: result.translatedText,
          });
        }
      } else if (node.type === 'llm-moderation') {
        const config = moderationConfigSchema.parse(node.config);
        let assessment: ViolationAssessment;
        const moderationText = bridgeReplyOriginalText
          ? [state.text.trim(), `被回复消息原文：${bridgeReplyOriginalText}`]
              .filter(Boolean)
              .join('\n')
          : state.text;
        if (!moderationText.trim() && !moderationOptions?.imageReviewRequested) {
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
            inputText: moderationText,
            ...(moderationOptions?.imageReviewRequested
              ? { imageCount: moderationOptions.imageCount }
              : {}),
          });
          try {
            assessment = moderationOptions
              ? await this.#processor.moderate(moderationText, config.prompt, {
                  ...moderationOptions,
                  enableThinking: config.enableThinking,
                })
              : await this.#processor.moderate(moderationText, config.prompt, {
                  enableThinking: config.enableThinking,
                });
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
            const llm = firstLlmFailure(error);
            if (llm) {
              await this.#log(message.traceId, 'error', 'llm_request_failed', {
                nodeId: node.id,
                nodeType: node.type,
                operation: 'moderation',
                failure: llm,
              });
            }
            assessment = {
              violationScore: 0,
              categories: ['processing-unavailable'],
              reason: '审核服务不可用；消息按故障放行策略继续。',
              confidence: 0,
              model: 'processing-unavailable',
              diagnostics: { error: errorDetails },
            };
            state = {
              ...state,
              text: processingFailureText('moderation', message.traceId, error),
              fixedText: false,
            };
          }
        }
        const processingUnavailable =
          assessment.model === 'image-review-unavailable' ||
          assessment.model === 'processing-unavailable';
        if (processingUnavailable && assessment.model === 'image-review-unavailable') {
          state = {
            ...state,
            text: processingFailureText(
              'moderation',
              message.traceId,
              new Error(assessment.reason),
            ),
            fixedText: false,
          };
        }
        // A technical failure is not a moderation verdict. Keep delivery moving
        // through the normal passed branch while surfacing the failure in-card.
        const passed = processingUnavailable || assessment.violationScore <= config.threshold;
        await this.#log(message.traceId, 'info', 'moderation_response', {
          nodeId: node.id,
          threshold: config.threshold,
          passed,
          selectedOutput: passed ? 'passed' : 'blocked',
          rawResult: assessment,
        });
        await recordActivity(node, processedSteps, {
          message: processingUnavailable
            ? '审核服务异常；已显示错误并按故障放行策略继续'
            : `此消息违规程度为 ${Math.round(assessment.violationScore * 100)}%，走“${passed ? '过审' : '未过'}”出口`,
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
        await recordActivity(node, processedSteps, {
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
        await recordActivity(node, processedSteps, {
          message: '等待人工审核',
          text: state.text,
        });
        paused = true;
        continue;
      } else if (node.type === 'card-renderer') {
        const target = this.#findDownstreamTarget(node.id, nodes, outgoing, sessions);
        if (!target) throw new Error('Image renderer has no reachable verified target session.');
        if (fastMode) {
          state = { text: state.text, fixedText: state.fixedText };
          await this.#log(message.traceId, 'info', 'render_skipped_fast_mode', {
            nodeId: node.id,
            targetSessionId: target.id,
          });
          await recordActivity(node, processedSteps, {
            message: '疾速模式：跳过图片下载和合成',
            text: state.text,
          });
        } else {
          const prepared = await this.#prepareRender(message, target, state.text, state.fixedText);
          state = {
            ...state,
            ...(prepared.renderSpec ? { renderSpec: prepared.renderSpec } : {}),
            ...(prepared.cards ? { cards: prepared.cards } : {}),
            renderedForSessionId: target.id,
          };
          await this.#log(message.traceId, 'info', 'render_succeeded', {
            nodeId: node.id,
            targetSessionId: target.id,
            renderMode: prepared.renderSpec ? 'client' : 'legacy',
            mediaCount: prepared.renderSpec
              ? prepared.renderSpec.images.length +
                (prepared.renderSpec.reply?.imagePreview ? 1 : 0) +
                (prepared.renderSpec.senderAvatar ? 1 : 0)
              : undefined,
            cardCount: prepared.cards?.length,
            byteSizes: prepared.cards?.map((card) => card.byteLength),
          });
          await recordActivity(node, processedSteps, {
            message: prepared.renderSpec
              ? '已提交客户端合成图片'
              : `已合成 ${prepared.cards?.length ?? 0} 张消息图片`,
            text: state.text,
          });
        }
      } else if (node.type === 'chat-output') {
        const targetId = chatConfigSchema.parse(node.config).sessionId;
        const target = sessions.find((session) => session.id === targetId);
        if (!target) throw new Error(`Target session ${targetId} is unavailable.`);
        if (target.fetchOnly) {
          // The bot never delivers into a fetch-only channel; this includes
          // blueprint forwards and replies that would land here.
          await this.#log(message.traceId, 'info', 'delivery_suppressed_fetch_only', {
            nodeId: node.id,
            targetSessionId: target.id,
          });
          await recordActivity(node, processedSteps, {
            message: `已拦截：机器人不向只读频道 ${target.remark?.trim() || target.displayName} 发送消息`,
            text: state.text,
          });
          continue;
        }
        let renderSpec = fastMode
          ? undefined
          : state.renderSpec && state.renderedForSessionId === target.id
            ? state.renderSpec
            : undefined;
        let cards = fastMode
          ? undefined
          : state.cards && state.renderedForSessionId === target.id
            ? state.cards
            : undefined;
        if (!fastMode && !renderSpec && !cards) {
          const prepared = await this.#prepareRender(message, target, state.text, state.fixedText);
          renderSpec = prepared.renderSpec;
          cards = prepared.cards;
        }
        const delivery: DeliveryIntent = {
          blueprint,
          sourceSession,
          target,
          message,
          ...(cards ? { cards } : {}),
          ...(renderSpec ? { renderSpec } : {}),
          processedText: state.text,
          fastMode,
        };
        if (deliveryCollector) deliveryCollector.push(delivery);
        else
          await this.#dispatchDelivery(
            blueprint,
            sourceSession,
            target,
            message,
            cards,
            renderSpec,
            state.text,
            fastMode,
          );
        await recordActivity(node, processedSteps, {
          message: `已发送到 ${target.remark?.trim() || target.displayName}`,
          text: state.text,
        });
        continue;
      } else if (node.type === 'simulated-output') {
        await recordActivity(node, processedSteps, {
          message: '模拟输出已收到结果',
          text: state.text,
        });
        continue;
      } else if (node.type === 'discard') {
        await this.#log(message.traceId, 'info', 'message_discarded', { nodeId: node.id });
        await recordActivity(node, processedSteps, {
          message: '消息已丢弃',
          text: state.text,
        });
        continue;
      } else if (node.type !== 'chat-input' && node.type !== 'simulated-input') {
        await recordActivity(node, processedSteps, {
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
    detail: BlueprintActivityDetail,
    activityBatch?: ActivityBatchContext,
  ): Promise<void> {
    const id = randomUUID();
    this.#activitySequence = Math.max(Date.now() * 1_000, this.#activitySequence + 1);
    const record: BlueprintActivityRecord = {
      id,
      blueprintId: blueprint.blueprintId,
      version: blueprint.version,
      traceId: message.traceId,
      ...(activityBatch
        ? {
            batchId: activityBatch.batchId,
            batchIndex: activityBatch.batchIndex,
            batchSize: activityBatch.batchSize,
          }
        : {}),
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

  async #prepareRender(
    message: MessageEnvelope,
    target: ChatSession,
    text: string,
    fixedText: boolean,
  ): Promise<{ readonly renderSpec?: MessageCardRenderSpec; readonly cards?: readonly Buffer[] }> {
    // Media is deliberately rendered centrally.  Sending the original image
    // bytes inside a client render spec would cost more bandwidth than sending
    // the already-composited card, especially when the same image is retried.
    if (hasImageContent(message) && this.#processor.render) {
      try {
        return { cards: await this.#render(message, target, text, fixedText) };
      } catch (error) {
        await this.#log(message.traceId, 'error', 'central_card_render_failed_forwarding', {
          targetSessionId: target.id,
          error: describeError(error),
        });
        if (this.#processor.prepareRender) {
          return {
            renderSpec: await this.#processor.prepareRender(
              message,
              target,
              processingFailureText('rendering', message.traceId, error),
              false,
            ),
          };
        }
        throw error;
      }
    }
    if (this.#processor.prepareRender) {
      return { renderSpec: await this.#processor.prepareRender(message, target, text, fixedText) };
    }
    // Keep old custom processors working while they are upgraded.  New
    // central processors never take this branch, so PNG bytes stay local to
    // the target node in the normal path.
    return { cards: await this.#render(message, target, text, fixedText) };
  }

  async #dispatchDelivery(
    blueprint: BlueprintVersion,
    sourceSession: ChatSession,
    target: ChatSession,
    message: MessageEnvelope,
    cards: readonly Buffer[] | undefined,
    renderSpec: MessageCardRenderSpec | undefined,
    processedText: string,
    fastMode: boolean,
  ): Promise<void> {
    const prepared = await this.#prepareDelivery({
      blueprint,
      sourceSession,
      target,
      message,
      ...(cards ? { cards } : {}),
      ...(renderSpec ? { renderSpec } : {}),
      processedText,
      fastMode,
    });
    await this.#sendPreparedDelivery(prepared);
  }

  async #prepareDelivery(intent: DeliveryIntent): Promise<PreparedDelivery> {
    const {
      blueprint,
      sourceSession,
      target,
      message,
      cards,
      renderSpec,
      processedText,
      fastMode,
    } = intent;
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
      ...(cards ? { cardCount: cards.length } : {}),
      ...(renderSpec
        ? {
            renderMode: 'client',
            mediaCount:
              renderSpec.images.length +
              (renderSpec.reply?.imagePreview ? 1 : 0) +
              (renderSpec.senderAvatar ? 1 : 0),
          }
        : {}),
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
      mode: fastMode ? 'text' : 'card',
      cards: fastMode || !cards ? [] : cards.map((card) => card.toString('base64')),
      ...(renderSpec ? { render: renderSpec } : {}),
      ...(fastMode
        ? {
            // Images/attachments have no rendered card in speed mode.  Keep a
            // deterministic text fallback instead of sending an invalid empty
            // command to the node.
            text: processedText || '不支持的消息',
            senderName: message.sender.displayName,
            fastMode: true,
          }
        : {}),
      ...(mappedReplyId ? { replyMessageId: mappedReplyId } : {}),
    };
    return { intent, command };
  }

  async #sendPreparedDelivery(prepared: PreparedDelivery): Promise<void> {
    const { intent, command } = prepared;
    const { sourceSession, message, target, cards, renderSpec } = intent;
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
        ...(cards ? { cardCount: cards.length } : {}),
        ...(renderSpec ? { renderMode: 'client', mediaCount: renderSpec.images.length } : {}),
        replyMessageId: command.replyMessageId,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.#store.set('delivery-task', command.taskId, {
        ...(await this.#store.get<Record<string, unknown>>('delivery-task', command.taskId))?.value,
        status: 'failed',
        error: errorMessage,
        updatedAt: new Date().toISOString(),
      });
      await this.#log(message.traceId, 'error', 'delivery_command_failed', {
        taskId: command.taskId,
        targetSessionId: target.id,
        error: errorMessage,
      });
      await this.#deliverErrorNotice(
        message.traceId,
        sourceSession.id,
        target.id,
        errorMessage,
        message.source.messageId,
      );
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
          const payload = {
            batchId: randomUUID(),
            deliveries: chunk.map(({ command }) => command),
          };
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
                ...(intent.cards ? { cardCount: intent.cards.length } : {}),
                ...(intent.renderSpec
                  ? { renderMode: 'client', mediaCount: intent.renderSpec.images.length }
                  : {}),
                replyMessageId: command.replyMessageId,
              });
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            for (const { intent, command } of chunk) {
              await this.#store.set('delivery-task', command.taskId, {
                ...(await this.#store.get<Record<string, unknown>>('delivery-task', command.taskId))
                  ?.value,
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
              await this.#deliverErrorNotice(
                intent.message.traceId,
                intent.sourceSession.id,
                intent.target.id,
                message,
                intent.message.source.messageId,
              );
            }
          }
        }
      }),
    );
  }

  /**
   * Surface a failed delivery to the user instead of dropping it silently: an
   * error card is rendered and sent to the source session. The card is a
   * non-replyable system notice, so it never enters a blueprint again and its
   * own failure path cannot recurse (it has no delivery-task record).
   */
  async #deliverErrorNotice(
    traceId: string,
    sourceSessionId: string,
    targetSessionId: string,
    errorMessage: string,
    sourceMessageId: string,
  ): Promise<void> {
    try {
      const [sourceEntry, targetEntry] = await Promise.all([
        this.#store.get<ChatSession>('chat-session', sourceSessionId),
        this.#store.get<ChatSession>('chat-session', targetSessionId),
      ]);
      if (!sourceEntry) return;
      const sourceSession = chatSessionSchema.parse(sourceEntry.value);
      if (sourceSession.status !== 'verified') return;
      const targetName = targetEntry
        ? chatSessionSchema.parse(targetEntry.value).displayName
        : '未知会话';
      const cardSettings = cardSettingsSchema.parse(
        (await this.#store.get('settings', 'card'))?.value ?? {},
      );
      const spec: MessageCardRenderSpec = {
        themeId: cardSettings.themeId,
        sourcePlatform: sourceSession.platform,
        targetLanguage: sourceSession.platform === 'discord' ? 'en' : 'zh',
        sourceName: targetName,
        senderName: 'DisQord',
        sentAt: new Date().toISOString(),
        primaryText: `⚠️ 消息发送失败\n${errorMessage}`,
        images: [],
        nonReplyable: true,
        traceLabel: traceId.slice(0, 8),
      };
      const command: OutboundDeliveryCommand = {
        taskId: randomUUID(),
        sourceSessionId: sourceSession.id,
        sourceMessageId,
        targetSessionId: sourceSession.id,
        externalId: sourceSession.externalId,
        mode: 'card',
        cards: [],
        render: spec,
        errorNotice: true,
      };
      await this.#commandBus.sendToNode(sourceSession.nodeId, 'message.deliver', command);
      await this.#log(traceId, 'error', 'delivery_error_notice_sent', {
        taskId: command.taskId,
        sourceSessionId: sourceSession.id,
        targetSessionId,
        error: errorMessage,
      });
    } catch (error) {
      await this.#log(traceId, 'error', 'delivery_error_notice_failed', {
        sourceSessionId,
        targetSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
    const createdAt = new Date().toISOString();
    await this.#store.set(
      'reply-mapping',
      mappingKey(delivered.sourceSessionId, delivered.sourceMessageId, delivered.targetSessionId),
      { targetMessageId: delivered.targetMessageId, createdAt },
    );
    // Keep the inverse relation as well.  A reply arriving from the target
    // session uses the target platform's message ID as its source ID, so the
    // normal lookup must be able to translate it back to the source message.
    await this.#store.set(
      'reply-mapping',
      mappingKey(delivered.targetSessionId, delivered.targetMessageId, delivered.sourceSessionId),
      { targetMessageId: delivered.sourceMessageId, createdAt },
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
      const traceId = String(task.value.traceId);
      await this.#store.set('delivery-task', failed.taskId, {
        ...task.value,
        status: 'failed',
        error: failed.error,
        updatedAt: new Date().toISOString(),
      });
      await this.#log(traceId, 'error', 'delivery_failed', failed);
      await this.#deliverErrorNotice(
        traceId,
        failed.sourceSessionId,
        failed.targetSessionId,
        failed.error,
        failed.sourceMessageId,
      );
    }
  }

  async #resolveBridgeReply(
    sourceSession: ChatSession,
    sessions: readonly ChatSession[],
    reply: MessageEnvelope['replyTo'],
  ): Promise<MessageEnvelope | undefined> {
    if (!reply) return undefined;

    for (const targetSession of sessions) {
      if (targetSession.id === sourceSession.id) continue;
      const mapping = await this.#store.get<{ targetMessageId: string }>(
        'reply-mapping',
        mappingKey(sourceSession.id, reply.sourceMessageId, targetSession.id),
      );
      const originalMessageId = mapping?.value.targetMessageId;
      if (!originalMessageId) continue;

      const history = await this.#store.list<{
        sessionId: string;
        message: MessageEnvelope;
      }>('message-history');
      const originalEntry = history.find(
        (entry) =>
          entry.value.sessionId === targetSession.id &&
          entry.value.message.source.messageId === originalMessageId,
      );
      if (!originalEntry) continue;

      const parsed = messageEnvelopeSchema.safeParse(originalEntry.value.message);
      if (parsed.success) return parsed.data;
    }
    return undefined;
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

interface LlmProviderConnection {
  readonly provider: LlmProviderSettings;
  readonly client: OpenAICompatibleClient;
}

export class CentralMessageProcessor implements MessageProcessor {
  readonly #store: StateStore;
  readonly #secrets: SecretStore;
  readonly #avatarCache: AvatarCache;

  constructor(store: StateStore, secrets: SecretStore, avatarCachePath = './data/avatar-cache') {
    this.#store = store;
    this.#secrets = secrets;
    this.#avatarCache = new AvatarCache(avatarCachePath);
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
    enableThinking: boolean,
  ): Promise<TranslationResult> {
    const protectedText = protectCustomEmojiText(text, message.customEmojis);
    const failures: Error[] = [];
    const connections = (await this.#clients()).filter(
      ({ provider }) => provider.translationEnabled && Boolean(provider.translationModel.trim()),
    );
    if (!connections.length) {
      throw new LlmProviderChainError('Translation', [new Error('没有启用翻译用途的模型配置。')]);
    }
    for (const { provider, client } of connections) {
      try {
        const result = await new LlmTranslationService(client).translate({
          text: protectedText.text,
          targetLanguage: target.platform === 'discord' ? 'en' : 'zh',
          model: provider.translationModel,
          prompt: { content: prompt, version: 1 },
          enableThinking,
          temperature: provider.translationTemperature,
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
        return {
          ...result,
          translatedText: protectedText.restore(result.translatedText),
        };
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    throw new LlmProviderChainError('Translation', failures);
  }

  async moderate(
    text: string,
    prompt: string,
    options?: {
      readonly imageReviewRequested?: boolean;
      readonly imageCount?: number;
      readonly imageUrls?: readonly string[];
      readonly enableThinking?: boolean;
    },
  ): Promise<ViolationAssessment> {
    const connections = await this.#clients();
    const failures: Error[] = [];
    if (!options?.imageReviewRequested) {
      const eligible = connections.filter(
        ({ provider }) => provider.moderationEnabled && Boolean(provider.moderationModel.trim()),
      );
      if (!eligible.length) {
        throw new LlmProviderChainError('Moderation', [
          new Error('没有启用文本审核用途的模型配置。'),
        ]);
      }
      for (const { provider, client } of eligible) {
        try {
          return await new LlmModerationService(client).moderate({
            text,
            model: provider.moderationModel,
            prompt: { content: prompt, version: 1 },
            temperature: provider.moderationTemperature,
            ...(options?.enableThinking === undefined
              ? {}
              : { enableThinking: options.enableThinking }),
          });
        } catch (error) {
          failures.push(error instanceof Error ? error : new Error(String(error)));
        }
      }
      throw new LlmProviderChainError('Moderation', failures);
    }

    const imageUrls = options.imageUrls ?? [];
    if (!imageUrls.length || imageUrls.length !== options.imageCount) {
      throw new LlmProviderChainError('Image moderation', [
        new Error('图片地址缺失，无法进行图片审核。'),
      ]);
    }
    const eligible = connections.filter(
      ({ provider }) =>
        provider.imageModerationEnabled &&
        Boolean(provider.imageModerationModel.trim()) &&
        imageUrls.length <= provider.maxImageCount,
    );
    if (!eligible.length) {
      throw new LlmProviderChainError('Image moderation', [
        new Error('没有可处理当前图片数量的视觉模型配置。'),
      ]);
    }

    let images: string[];
    try {
      const maxBytes = Math.max(...eligible.map(({ provider }) => provider.maxImageBytes));
      images = await Promise.all(
        imageUrls.map(
          async (url) =>
            (
              await downloadExternalImage(url, {
                maxBytes,
              })
            ).dataUri,
        ),
      );
    } catch (error) {
      throw new LlmProviderChainError('Image moderation', [
        error instanceof Error ? error : new Error(String(error)),
      ]);
    }

    for (const { provider, client } of eligible) {
      try {
        return await new LlmModerationService(client).moderate({
          text,
          model: provider.imageModerationModel,
          prompt: { content: prompt, version: 1 },
          images,
          imageDetail: provider.imageModerationDetail,
          temperature: provider.moderationTemperature,
          ...(options?.enableThinking === undefined
            ? {}
            : { enableThinking: options.enableThinking }),
        });
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    throw new LlmProviderChainError('Image moderation', failures);
  }

  async resolveAvatar(avatarKey: string): Promise<string | undefined> {
    const parsedKey = avatarKeySchema.safeParse(avatarKey);
    if (!parsedKey.success) return undefined;
    const entry = await this.#store.get<unknown>(AVATAR_SOURCE_NAMESPACE, parsedKey.data);
    if (!entry) return undefined;
    const source = avatarSourceRecordSchema.safeParse(entry.value);
    if (!source.success) return undefined;
    const avatar = await this.#avatarCache.get(source.data.sourceUrl);
    return avatar?.dataUri;
  }

  async prepareRender(
    message: MessageEnvelope,
    target: ChatSession,
    text: string,
    fixedText: boolean,
  ): Promise<MessageCardRenderSpec> {
    return await this.#buildRenderSpec(message, target, text, fixedText, false);
  }

  /** Build the full central-render input, including downloaded media. */
  async #buildRenderSpec(
    message: MessageEnvelope,
    target: ChatSession,
    text: string,
    fixedText: boolean,
    includeImages: boolean,
  ): Promise<MessageCardRenderSpec> {
    const cardSettingsEntry = await this.#store.get('settings', 'card');
    const cardSettings = cardSettingsSchema.parse(cardSettingsEntry?.value ?? {});
    const sourceSession = (await this.#store.list<ChatSession>('chat-session'))
      .map((entry) => chatSessionSchema.parse(entry.value))
      .find(
        (session) =>
          session.nodeId === message.source.nodeId &&
          session.platform === message.source.platform &&
          session.externalId === message.source.channelId &&
          session.status === 'verified',
      );
    const senderAvatarKey = message.sender.avatarUrl
      ? createAvatarKey(message.source.platform, message.sender.id)
      : undefined;
    if (senderAvatarKey && message.sender.avatarUrl) {
      await this.#rememberAvatarSource(senderAvatarKey, message.sender.avatarUrl);
    }
    const avatar =
      includeImages && message.sender.avatarUrl
        ? await this.#avatarCache.get(message.sender.avatarUrl)
        : undefined;
    const replyImage =
      includeImages && message.replyTo?.imagePreview?.sourceUrl
        ? await downloadExternalImage(message.replyTo.imagePreview.sourceUrl).catch(() => undefined)
        : undefined;
    const images = includeImages
      ? (
          await Promise.all(
            message.attachments.map(async (attachment) =>
              attachment.sourceUrl
                ? await downloadExternalImage(attachment.sourceUrl).catch(() => undefined)
                : undefined,
            ),
          )
        )
          .filter((image): image is NonNullable<typeof image> => Boolean(image))
          .map((image) => image.dataUri)
      : [];
    const [inlineEmojis, replyInlineEmojis] = await Promise.all([
      this.#resolveInlineEmojis(message.customEmojis),
      this.#resolveInlineEmojis(message.replyTo?.customEmojis),
    ]);
    return {
      themeId: cardSettings.themeId,
      sourcePlatform: message.source.platform,
      targetLanguage: target.platform === 'discord' ? 'en' : 'zh',
      sourceName: message.source.channelId,
      senderName: message.sender.displayName,
      ...(senderAvatarKey ? { senderAvatarKey } : {}),
      ...(avatar ? { senderAvatar: avatar.dataUri } : {}),
      sentAt: message.sentAt,
      primaryText: text,
      ...(!fixedText && message.text ? { originalText: message.text } : {}),
      images: images.map((dataUri) => ({ dataUri })),
      ...(inlineEmojis.length ? { inlineEmojis } : {}),
      ...(message.replyTo
        ? {
            reply: {
              senderName: message.replyTo.senderDisplayName,
              ...(message.replyTo.textPreview ? { textPreview: message.replyTo.textPreview } : {}),
              ...(replyInlineEmojis.length ? { inlineEmojis: replyInlineEmojis } : {}),
              ...(replyImage ? { imagePreview: { dataUri: replyImage.dataUri } } : {}),
            },
          }
        : {}),
      ...(!fixedText && message.unsupportedType
        ? { unsupportedType: message.unsupportedType }
        : {}),
      // A card forwarded out of a fetch-only channel is non-replyable: the
      // reply's return delivery into that channel is suppressed by the bot.
      ...(sourceSession?.fetchOnly ? { nonReplyable: true } : {}),
      traceLabel: message.traceId.slice(0, 8),
    } satisfies MessageCardRenderSpec;
  }

  async #resolveInlineEmojis(
    emojis: MessageEnvelope['customEmojis'],
  ): Promise<NonNullable<MessageCardRenderSpec['inlineEmojis']>> {
    return (
      await Promise.all(
        (emojis ?? []).map(async (emoji) => {
          const dataUri =
            emoji.dataUri ??
            (emoji.sourceUrl
              ? (
                  await downloadExternalImage(emoji.sourceUrl, {
                    maxBytes: 2 * 1024 * 1024,
                    resize: { width: 64, height: 64, fit: 'inside' },
                  }).catch(() => undefined)
                )?.dataUri
              : undefined);
          return {
            token: emoji.token,
            ...(emoji.id ? { id: emoji.id } : {}),
            ...(dataUri ? { dataUri } : {}),
          };
        }),
      )
    ).filter((emoji): emoji is NonNullable<typeof emoji> => Boolean(emoji));
  }

  async #rememberAvatarSource(avatarKey: string, sourceUrl: string): Promise<void> {
    const existing = await this.#store.get<{ sourceUrl: string }>(
      AVATAR_SOURCE_NAMESPACE,
      avatarKey,
    );
    if (existing?.value.sourceUrl === sourceUrl) return;
    await this.#store.set(AVATAR_SOURCE_NAMESPACE, avatarKey, { sourceUrl });
  }

  /**
   * Legacy escape hatch for custom processors. The normal orchestrator path
   * calls prepareRender and sends the render spec to the target node instead.
   */
  async render(
    message: MessageEnvelope,
    target: ChatSession,
    text: string,
    fixedText: boolean,
  ): Promise<readonly Buffer[]> {
    return await renderMessageCards(
      await this.#buildRenderSpec(message, target, text, fixedText, true),
    );
  }

  async #clients(): Promise<readonly LlmProviderConnection[]> {
    const settingsEntry = await this.#store.get('settings', 'llm');
    if (!settingsEntry) throw new Error('大模型 API 尚未配置。');
    const settings = llmSettingsSchema.parse(settingsEntry.value);
    const connections: LlmProviderConnection[] = [];
    const failures: Error[] = [];
    const enabled = settings.providers.filter((provider) => provider.enabled);
    for (const [index, provider] of enabled.entries()) {
      const apiKey =
        (await this.#secrets.get(`llm-api-key:${provider.id}`)) ??
        (index === 0 ? await this.#secrets.get('llm-api-key') : undefined);
      if (!apiKey) {
        failures.push(new Error(`${provider.name} 未配置 API 密钥。`));
        continue;
      }
      try {
        connections.push({
          provider,
          client: new OpenAICompatibleClient({
            baseUrl: provider.baseUrl,
            apiKey,
            timeoutMs: provider.timeoutMs,
            maxRetries: provider.maxRetries,
            retryDelayMs: provider.retryDelayMs,
            responseFormatMode: provider.responseFormatMode,
            ...(provider.maxTokens === undefined ? {} : { maxTokens: provider.maxTokens }),
          }),
        });
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (!connections.length) {
      throw new LlmProviderChainError(
        'LLM setup',
        failures.length ? failures : [new Error('没有已启用的模型配置。')],
      );
    }
    return connections;
  }
}

function protectCustomEmojiText(
  text: string,
  customEmojis: MessageEnvelope['customEmojis'],
): { readonly text: string; readonly restore: (translatedText: string) => string } {
  const replacements = (customEmojis ?? []).map((emoji, index) => ({
    token: emoji.token,
    placeholder: `__DISQORD_CUSTOM_EMOJI_${index}__`,
  }));
  let protectedText = text;
  for (const replacement of replacements) {
    protectedText = protectedText.replaceAll(replacement.token, replacement.placeholder);
  }
  return {
    text: protectedText,
    restore: (translatedText) => {
      let restored = translatedText;
      for (const replacement of replacements) {
        restored = restored.replaceAll(replacement.placeholder, replacement.token);
      }
      return restored;
    },
  };
}

function hasImageContent(message: MessageEnvelope): boolean {
  return message.attachments.length > 0 || Boolean(message.replyTo?.imagePreview);
}

function mappingKey(
  sourceSessionId: string,
  sourceMessageId: string,
  targetSessionId: string,
): string {
  return `${sourceSessionId}:${sourceMessageId}:${targetSessionId}`;
}

/** The numeric ID fallback used when a session is created before its name is resolved. */
function isFallbackSessionName(name: string): boolean {
  return /^(?:QQ|Discord) [\d/ ]+$/u.test(name.trim());
}
