import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  LlmModerationService,
  LlmTranslationService,
  OpenAICompatibleClient,
  PromptVersionStore,
} from './index.js';

function jsonCompletion(content: unknown): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(content) } }],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('LLM translation and moderation', () => {
  it('returns a schema-validated translation with model and prompt version', async () => {
    const fetchImplementation = vi.fn(async () =>
      jsonCompletion({
        detectedLanguage: 'zh',
        translatedText: 'Hello',
        confidence: 0.99,
      }),
    );
    const client = new OpenAICompatibleClient({
      baseUrl: 'https://llm.example.test/v1',
      apiKey: 'test-key',
      fetchImplementation,
    });
    const service = new LlmTranslationService(client);

    await expect(
      service.translate({
        text: '你好',
        targetLanguage: 'en',
        model: 'translation-model',
        prompt: { content: 'Translate accurately.', version: 3 },
      }),
    ).resolves.toEqual({
      detectedLanguage: 'zh',
      translatedText: 'Hello',
      confidence: 0.99,
      model: 'translation-model',
      promptVersion: 3,
    });

    const body = JSON.parse(String(fetchImplementation.mock.calls[0]?.[1]?.body)) as {
      messages: Array<{ content: unknown }>;
      response_format: { type: string };
    };
    expect(JSON.stringify(body.messages)).toContain('untrustedUserData');
    expect(typeof body.messages[2]?.content).toBe('string');
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('includes the provider error message when an API request is rejected', async () => {
    const client = new OpenAICompatibleClient({
      baseUrl: 'https://llm.example.test/v1',
      apiKey: 'test-key',
      maxRetries: 0,
      fetchImplementation: vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: 'Unsupported response format' } }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    });

    await expect(
      new LlmTranslationService(client).translate({
        text: '你好',
        targetLanguage: 'en',
        model: 'translation-model',
        prompt: { content: 'Translate accurately.', version: 1 },
      }),
    ).rejects.toThrow('400: Unsupported response format');
  });

  it('fails closed when moderation output violates the schema', async () => {
    const client = new OpenAICompatibleClient({
      baseUrl: 'https://llm.example.test/v1',
      apiKey: 'test-key',
      maxRetries: 0,
      fetchImplementation: vi.fn(async () =>
        jsonCompletion({
          riskLevel: 'safe-ish',
          decision: 'allow',
          categories: [],
          reason: 'invalid risk enum',
          confidence: 1,
        }),
      ),
    });
    const service = new LlmModerationService(client);

    await expect(
      service.moderate({
        text: 'hello',
        model: 'moderation-model',
        prompt: { content: 'Classify risk.', version: 1 },
      }),
    ).rejects.toThrow();
  });
});

describe('PromptVersionStore', () => {
  it('keeps drafts out of production until explicitly published', () => {
    const store = new PromptVersionStore();
    const administratorId = randomUUID();
    store.createDefaultVersions(administratorId);
    const initial = store.getPublished('translation-system');
    const draft = store.createDraft('translation-system', 'New prompt.', administratorId);

    expect(store.getPublished('translation-system').id).toBe(initial.id);
    expect(store.publish(draft.id)).toMatchObject({ id: draft.id, status: 'published' });
    expect(store.getPublished('translation-system').id).toBe(draft.id);
    expect(store.list('translation-system')).toHaveLength(2);
  });
});
