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
  llmSettingsSchema,
  type ViolationAssessment,
} from '@disqord/llm';
import {
  blueprintVersionSchema,
  blueprintSchema,
  chatSessionSchema,
  createMessageIdempotencyKey,
  messageEnvelopeSchema,
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

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

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
  moderate?(text: string, prompt: string): Promise<ViolationAssessment>;
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

interface ManualReviewRecord {
  readonly taskId: string;
  readonly traceId: string;
  readonly status: 'pending' | 'processing' | 'approved' | 'rejected';
  readonly reason: string;
  readonly blueprintId: string;
  readonly blueprintVersion: number;
  readonly reviewNodeId: string;
  readonly sourceSessionId: string;
  readonly message: MessageEnvelope;
  readonly recentMessages: readonly MessageEnvelope[];
  readonly state: Pick<PipelineState, 'text' | 'fixedText'>;
  readonly createdAt: string;
  readonly resolvedAt?: string;
  readonly error?: string;
}

export class MessageOrchestrator {
  readonly #store: StateStore;
  readonly #commandBus: NodeCommandBus;
  readonly #processor: MessageProcessor;

  constructor(store: StateStore, commandBus: NodeCommandBus, processor: MessageProcessor) {
    this.#store = store;
    this.#commandBus = commandBus;
    this.#processor = processor;
  }

  async handleNodeFrame(frame: ReceivedNodeFrame): Promise<void> {
    if (frame.kind === 'message.upload') {
      await this.#handleMessageUpload(frame);
    } else if (frame.kind === 'message.delivered') {
      await this.#handleDelivered(frame.payload);
    } else if (frame.kind === 'message.delivery_failed') {
      await this.#handleDeliveryFailed(frame.payload);
    } else if (frame.kind === 'session.candidates') {
      await this.#store.set('session-candidates', frame.nodeId, frame.payload);
    }
  }

  async #handleMessageUpload(frame: ReceivedNodeFrame): Promise<void> {
    const message = messageEnvelopeSchema.parse(frame.payload);
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
        });
      }
    }
  }

  async #executeBlueprint(
    blueprint: BlueprintVersion,
    sourceSession: ChatSession,
    sessions: readonly ChatSession[],
    message: MessageEnvelope,
    recentMessages: readonly MessageEnvelope[],
    initialWork?: readonly WorkItem[],
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

      if (node.type === 'llm-translation' && state.text.trim()) {
        const config = translationConfigSchema.parse(node.config);
        const target = this.#findDownstreamTarget(node.id, nodes, outgoing, sessions);
        if (!target) throw new Error('Translation node has no reachable verified target session.');
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
        const result = await this.#processor.translate(
          message,
          target,
          state.text,
          config.prompt,
          recentMessages,
          config.memoryMode,
        );
        await this.#log(message.traceId, 'info', 'translation_response', {
          nodeId: node.id,
          rawResult: result,
        });
        state = { ...state, text: result.translatedText, fixedText: false };
      } else if (node.type === 'llm-moderation') {
        const config = moderationConfigSchema.parse(node.config);
        let assessment: ViolationAssessment;
        if (!state.text.trim()) {
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
          });
          assessment = await this.#processor.moderate(state.text, config.prompt);
        }
        const passed = assessment.violationScore <= config.threshold;
        await this.#log(message.traceId, 'info', 'moderation_response', {
          nodeId: node.id,
          threshold: config.threshold,
          passed,
          selectedOutput: passed ? 'passed' : 'blocked',
          rawResult: assessment,
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
      } else if (node.type === 'chat-output') {
        const targetId = chatConfigSchema.parse(node.config).sessionId;
        const target = sessions.find((session) => session.id === targetId);
        if (!target) throw new Error(`Target session ${targetId} is unavailable.`);
        const cards =
          state.cards && state.renderedForSessionId === target.id
            ? state.cards
            : await this.#render(message, target, state.text, state.fixedText);
        await this.#dispatchDelivery(blueprint, sourceSession, target, message, cards, state.text);
        continue;
      } else if (node.type === 'discard') {
        await this.#log(message.traceId, 'info', 'message_discarded', { nodeId: node.id });
        continue;
      }

      for (const edge of outgoing.get(node.id) ?? []) {
        work.push({ nodeId: edge.targetNodeId, state });
      }
    }
    return { paused };
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
    const command = {
      taskId,
      sourceSessionId: sourceSession.id,
      sourceMessageId: message.source.messageId,
      targetSessionId: target.id,
      externalId: target.externalId,
      cards: cards.map((card) => card.toString('base64')),
      ...(mappedReplyId ? { replyMessageId: mappedReplyId } : {}),
    };
    try {
      await this.#commandBus.sendToNode(target.nodeId, 'message.deliver', command);
      await this.#log(message.traceId, 'info', 'delivery_queued', {
        taskId,
        target: {
          nodeId: target.nodeId,
          platform: target.platform,
          sessionId: target.id,
          externalId: target.externalId,
        },
        cardCount: cards.length,
        replyMessageId: mappedReplyId,
      });
    } catch (error) {
      await this.#store.set('delivery-task', taskId, {
        ...(await this.#store.get<Record<string, unknown>>('delivery-task', taskId))?.value,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString(),
      });
      await this.#log(message.traceId, 'error', 'delivery_command_failed', {
        taskId,
        targetSessionId: target.id,
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
      const sourceSession = sessions.find((session) => session.id === review.sourceSessionId);
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

  async moderate(text: string, prompt: string): Promise<ViolationAssessment> {
    const { settings, client } = await this.#client();
    return await new LlmModerationService(client).moderate({
      text,
      model: settings.moderationModel,
      prompt: { content: prompt, version: 1 },
    });
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
