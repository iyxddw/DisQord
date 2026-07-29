import { randomUUID } from 'node:crypto';

import { simulateBlueprint } from '@disqord/blueprint';
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
} from '@disqord/llm';
import {
  blueprintVersionSchema,
  chatSessionSchema,
  createMessageIdempotencyKey,
  messageEnvelopeSchema,
  promptTemplateVersionSchema,
  type BlueprintVersion,
  type ChatSession,
  type MessageEnvelope,
  type PromptTemplateVersion,
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
  process(message: MessageEnvelope, target: ChatSession): Promise<ProcessingResult>;
  processApproved?(message: MessageEnvelope, target: ChatSession): Promise<ProcessingResult>;
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
    } else if (frame.kind === 'session.candidates') {
      await this.#store.set('session-candidates', frame.nodeId, frame.payload);
    }
  }

  async #handleMessageUpload(frame: ReceivedNodeFrame): Promise<void> {
    const message = messageEnvelopeSchema.parse(frame.payload);
    if (message.source.nodeId !== frame.nodeId || message.source.platform !== frame.nodeType) {
      throw new Error('Uploaded message source does not match the authenticated node.');
    }
    const dedupeKey = createMessageIdempotencyKey(message);
    if (await this.#store.get('message-dedupe', dedupeKey)) return;
    await this.#store.set('message-dedupe', dedupeKey, {
      eventId: message.eventId,
      receivedAt: new Date().toISOString(),
    });

    const sessions = (await this.#store.list<ChatSession>('chat-session'))
      .map((entry) => chatSessionSchema.parse(entry.value))
      .filter((session) => session.status === 'verified');
    const sourceSession = sessions.find(
      (session) =>
        session.nodeId === frame.nodeId &&
        session.platform === frame.nodeType &&
        session.externalId === message.source.channelId,
    );
    if (!sourceSession) {
      await this.#log(message.traceId, 'unmatched_session', { nodeId: frame.nodeId });
      return;
    }

    const blueprintEntries = await this.#store.list<BlueprintVersion>('blueprint-version');
    const published = blueprintEntries
      .map((entry) => blueprintVersionSchema.parse(entry.value))
      .filter((version) => version.status === 'published');
    const verifiedIds = new Set(sessions.map((session) => session.id));
    const targets = new Set<string>();
    for (const blueprint of published) {
      const result = simulateBlueprint(blueprint, sourceSession.id, message, {
        isVerifiedSession: (sessionId) => verifiedIds.has(sessionId),
      });
      for (const target of result.outputSessionIds) targets.add(target);
    }

    if (!targets.size) {
      await this.#log(message.traceId, 'unmatched_blueprint', { sessionId: sourceSession.id });
      return;
    }

    for (const targetId of targets) {
      const target = sessions.find((session) => session.id === targetId);
      if (!target) continue;
      const taskId = randomUUID();
      let result: ProcessingResult;
      try {
        result = await this.#processor.process(message, target);
      } catch (error) {
        result = {
          decision: 'review',
          reason:
            error instanceof Error
              ? `自动处理失败：${error.message}`
              : '自动处理失败，需要人工审核。',
        };
      }
      await this.#store.set('delivery-task', taskId, {
        id: taskId,
        traceId: message.traceId,
        sourceSessionId: sourceSession.id,
        targetSessionId: target.id,
        decision: result.decision,
        moderation: result.moderation,
        reason: result.reason,
        createdAt: new Date().toISOString(),
      });
      if (result.decision === 'review') {
        await this.#store.set('moderation-review', taskId, {
          taskId,
          traceId: message.traceId,
          sourceSession,
          targetSession: target,
          message,
          moderation: result.moderation,
          reason: result.reason,
          status: 'pending',
          createdAt: new Date().toISOString(),
        });
        continue;
      }
      if (result.decision === 'block' || !result.cards?.length) continue;

      const mappedReplyId = message.replyTo
        ? (
            await this.#store.get<{ targetMessageId: string }>(
              'reply-mapping',
              mappingKey(sourceSession.id, message.replyTo.sourceMessageId, target.id),
            )
          )?.value.targetMessageId
        : undefined;
      await this.#commandBus.sendToNode(target.nodeId, 'message.deliver', {
        taskId,
        sourceSessionId: sourceSession.id,
        sourceMessageId: message.source.messageId,
        targetSessionId: target.id,
        externalId: target.externalId,
        cards: result.cards.map((card) => card.toString('base64')),
        ...(mappedReplyId ? { replyMessageId: mappedReplyId } : {}),
      });
    }
  }

  async handleReview(taskId: string, decision: 'approve' | 'reject'): Promise<void> {
    const entry = await this.#store.get<{
      taskId: string;
      sourceSession: ChatSession;
      targetSession: ChatSession;
      message: MessageEnvelope;
      status: string;
    }>('moderation-review', taskId);
    if (!entry) throw new Error('Moderation review not found.');
    if (entry.value.status !== 'pending') throw new Error('Moderation review is already resolved.');
    if (decision === 'reject') {
      await this.#store.set('moderation-review', taskId, {
        ...entry.value,
        status: 'rejected',
        resolvedAt: new Date().toISOString(),
      });
      return;
    }
    const process = this.#processor.processApproved?.bind(this.#processor);
    const result = process
      ? await process(entry.value.message, entry.value.targetSession)
      : await this.#processor.process(entry.value.message, entry.value.targetSession);
    if (!result.cards?.length) throw new Error('Approved message did not produce a card.');
    const mappedReplyId = entry.value.message.replyTo
      ? (
          await this.#store.get<{ targetMessageId: string }>(
            'reply-mapping',
            mappingKey(
              entry.value.sourceSession.id,
              entry.value.message.replyTo.sourceMessageId,
              entry.value.targetSession.id,
            ),
          )
        )?.value.targetMessageId
      : undefined;
    await this.#commandBus.sendToNode(entry.value.targetSession.nodeId, 'message.deliver', {
      taskId,
      sourceSessionId: entry.value.sourceSession.id,
      sourceMessageId: entry.value.message.source.messageId,
      targetSessionId: entry.value.targetSession.id,
      externalId: entry.value.targetSession.externalId,
      cards: result.cards.map((card) => card.toString('base64')),
      ...(mappedReplyId ? { replyMessageId: mappedReplyId } : {}),
    });
    await this.#store.set('moderation-review', taskId, {
      ...entry.value,
      status: 'approved',
      resolvedAt: new Date().toISOString(),
    });
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
    }
  }

  async #log(traceId: string, event: string, details: unknown): Promise<void> {
    await this.#store.set('trace-log', randomUUID(), {
      traceId,
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
    if (message.kind === 'unsupported') {
      return {
        decision: 'allow',
        cards: await this.#render(message, target, ''),
      };
    }
    const settingsEntry = await this.#store.get('settings', 'llm');
    const apiKey = await this.#secrets.get('llm-api-key');
    if (!settingsEntry || !apiKey) {
      return { decision: 'review', reason: 'LLM settings or API key are not configured.' };
    }
    const settings = llmSettingsSchema.parse(settingsEntry.value);
    const prompts = (await this.#store.list<PromptTemplateVersion>('prompt')).map((entry) =>
      promptTemplateVersionSchema.parse(entry.value),
    );
    const moderationPrompt = combinePrompts(
      selectPrompt(prompts, 'moderation-system'),
      selectPrompt(prompts, 'moderation-rules'),
    );
    const translationPrompt = combinePrompts(
      selectPrompt(prompts, 'translation-system'),
      selectPrompt(prompts, 'translation-task'),
    );
    const client = new OpenAICompatibleClient({
      baseUrl: settings.baseUrl,
      apiKey,
      timeoutMs: settings.timeoutMs,
      maxRetries: settings.maxRetries,
    });
    const imageUrls = message.attachments
      .map((attachment) => attachment.sourceUrl)
      .filter((url): url is string => Boolean(url));
    if (imageUrls.length && !settings.moderationSupportsVision) {
      return {
        decision: 'review',
        reason: 'Image moderation requires a vision-capable model.',
      };
    }
    const moderation = await new LlmModerationService(client).moderate({
      ...(message.text ? { text: message.text } : {}),
      ...(imageUrls.length ? { imageUrls } : {}),
      model: settings.moderationModel,
      prompt: {
        content: moderationPrompt.content,
        version: moderationPrompt.version,
      },
    });
    if (moderation.decision !== 'allow') {
      return {
        decision: moderation.decision,
        moderation,
        reason: moderation.reason,
      };
    }
    let translated = message.text ?? '';
    if (message.text?.trim()) {
      const translation = await new LlmTranslationService(client).translate({
        text: message.text,
        targetLanguage: target.platform === 'discord' ? 'en' : 'zh',
        model: settings.translationModel,
        prompt: {
          content: translationPrompt.content,
          version: translationPrompt.version,
        },
      });
      translated = translation.translatedText;
    }
    return {
      decision: 'allow',
      moderation,
      cards: await this.#render(message, target, translated),
    };
  }

  async processApproved(message: MessageEnvelope, target: ChatSession): Promise<ProcessingResult> {
    if (message.kind === 'unsupported') {
      return { decision: 'allow', cards: await this.#render(message, target, '') };
    }
    const settingsEntry = await this.#store.get('settings', 'llm');
    const apiKey = await this.#secrets.get('llm-api-key');
    let translated = message.text ?? '';
    if (message.text?.trim() && settingsEntry && apiKey) {
      const settings = llmSettingsSchema.parse(settingsEntry.value);
      const prompts = (await this.#store.list<PromptTemplateVersion>('prompt')).map((entry) =>
        promptTemplateVersionSchema.parse(entry.value),
      );
      const prompt = combinePrompts(
        selectPrompt(prompts, 'translation-system'),
        selectPrompt(prompts, 'translation-task'),
      );
      const client = new OpenAICompatibleClient({
        baseUrl: settings.baseUrl,
        apiKey,
        timeoutMs: settings.timeoutMs,
        maxRetries: settings.maxRetries,
      });
      translated = (
        await new LlmTranslationService(client).translate({
          text: message.text,
          targetLanguage: target.platform === 'discord' ? 'en' : 'zh',
          model: settings.translationModel,
          prompt,
        })
      ).translatedText;
    }
    return {
      decision: 'allow',
      cards: await this.#render(message, target, translated),
    };
  }

  async #render(
    message: MessageEnvelope,
    target: ChatSession,
    primaryText: string,
  ): Promise<readonly Buffer[]> {
    const avatar = message.sender.avatarUrl
      ? await downloadExternalImage(message.sender.avatarUrl).catch(() => undefined)
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
      sourceName: message.source.channelId,
      senderName: message.sender.displayName,
      ...(avatar ? { senderAvatar: avatar.dataUri } : {}),
      sentAt: message.sentAt,
      primaryText,
      ...(message.text ? { originalText: message.text } : {}),
      images,
      ...(message.replyTo
        ? {
            reply: {
              senderName: message.replyTo.senderDisplayName,
              ...(message.replyTo.textPreview ? { textPreview: message.replyTo.textPreview } : {}),
            },
          }
        : {}),
      ...(message.unsupportedType ? { unsupportedType: message.unsupportedType } : {}),
      traceLabel: message.traceId.slice(0, 8),
    };
    void target;
    return await renderMessageCards(input);
  }
}

function selectPrompt(
  prompts: readonly PromptTemplateVersion[],
  purpose: PromptTemplateVersion['purpose'],
): PromptTemplateVersion {
  const prompt = prompts.find(
    (candidate) => candidate.purpose === purpose && candidate.status === 'published',
  );
  if (!prompt) throw new Error(`No published prompt exists for ${purpose}.`);
  return prompt;
}

function combinePrompts(
  first: PromptTemplateVersion,
  second: PromptTemplateVersion,
): { content: string; version: number } {
  return {
    content: `${first.content}\n\n${second.content}`,
    version: Math.max(first.version, second.version),
  };
}

function mappingKey(
  sourceSessionId: string,
  sourceMessageId: string,
  targetSessionId: string,
): string {
  return `${sourceSessionId}:${sourceMessageId}:${targetSessionId}`;
}
