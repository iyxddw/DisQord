import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  LlmModerationService,
  LlmTranslationService,
  OpenAICompatibleClient,
  PromptVersionStore,
  llmSettingsSchema,
} from './index.js';

function jsonCompletion(content: unknown): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(content) } }],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function rawJsonCompletion(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
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
        prompt: { content: '准确翻译。', version: 3 },
        recentMessages: [{ sender: 'Bob', text: '上一条消息' }],
        repliedMessage: { sender: 'Carol', text: '被回复消息' },
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
    expect(JSON.stringify(body.messages)).toContain('上一条消息');
    expect(JSON.stringify(body.messages)).toContain('被回复消息');
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

  it('uses Gemini structured output and tolerates a trailing explanation', async () => {
    const fetchImplementation = vi.fn(async () =>
      rawJsonCompletion(
        '{"detectedLanguage":"zh","translatedText":"Hello","confidence":0.99}\n\n补充：已完成翻译。',
      ),
    );
    const client = new OpenAICompatibleClient({
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      apiKey: 'test-key',
      fetchImplementation,
    });

    await expect(
      new LlmTranslationService(client).translate({
        text: '你好',
        targetLanguage: 'en',
        model: 'gemini-3.5-flash',
        prompt: { content: '准确翻译。', version: 1 },
      }),
    ).resolves.toMatchObject({ translatedText: 'Hello' });

    const body = JSON.parse(String(fetchImplementation.mock.calls[0]?.[1]?.body)) as {
      response_format: { type: string; json_schema?: { name: string; strict: boolean } };
    };
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema).toMatchObject({
      name: 'disqord_translation',
      strict: true,
    });
  });

  it('preserves provider content and parse position in a structured failure', async () => {
    const client = new OpenAICompatibleClient({
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      apiKey: 'test-key',
      maxRetries: 0,
      fetchImplementation: vi.fn(async () => rawJsonCompletion('{"broken": true}\nnot-json')),
    });

    await expect(
      new LlmTranslationService(client).translate({
        text: '你好',
        targetLanguage: 'en',
        model: 'gemini-3.5-flash',
        prompt: { content: '准确翻译。', version: 1 },
      }),
    ).rejects.toMatchObject({
      name: 'LlmRequestError',
      details: {
        stage: 'schema',
        contentPreview: expect.stringContaining('not-json'),
        parserError: expect.stringContaining('detectedLanguage'),
      },
    });
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

  it('returns a schema-validated violation score for threshold routing', async () => {
    const client = new OpenAICompatibleClient({
      baseUrl: 'https://llm.example.test/v1',
      apiKey: 'test-key',
      fetchImplementation: vi.fn(async () =>
        jsonCompletion({
          violationScore: 0.72,
          categories: ['harassment'],
          reason: '存在明确的人身攻击',
          confidence: 0.94,
        }),
      ),
    });

    await expect(
      new LlmModerationService(client).moderate({
        text: '测试文本',
        model: 'moderation-model',
        prompt: { content: '评估违规程度。', version: 1 },
      }),
    ).resolves.toEqual({
      violationScore: 0.72,
      categories: ['harassment'],
      reason: '存在明确的人身攻击',
      confidence: 0.94,
      model: 'moderation-model',
    });
  });

  it('sends image data to the moderation model with the selected detail level', async () => {
    const fetchImplementation = vi.fn(async () =>
      jsonCompletion({
        violationScore: 0.91,
        categories: ['graphic-content'],
        reason: '图片包含明显违规内容',
        confidence: 0.98,
      }),
    );
    const client = new OpenAICompatibleClient({
      baseUrl: 'https://llm.example.test/v1',
      apiKey: 'test-key',
      fetchImplementation,
    });

    await new LlmModerationService(client).moderate({
      text: '请审核这张图',
      model: 'vision-moderation-model',
      prompt: { content: '审核图片中的违规内容。', version: 1 },
      images: ['data:image/png;base64,aGVsbG8='],
      imageDetail: 'high',
    });

    const body = JSON.parse(String(fetchImplementation.mock.calls[0]?.[1]?.body)) as {
      messages: Array<{ content: unknown }>;
    };
    expect(body.messages[2]?.content).toEqual([
      { type: 'text', text: expect.stringContaining('请审核这张图') },
      {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,aGVsbG8=', detail: 'high' },
      },
    ]);
  });

  it('sends an explicit thinking toggle to a DeepSeek-compatible endpoint', async () => {
    const fetchImplementation = vi.fn(async () =>
      jsonCompletion({
        detectedLanguage: 'zh',
        translatedText: 'Hello',
        confidence: 0.99,
      }),
    );
    const client = new OpenAICompatibleClient({
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'test-key',
      fetchImplementation,
    });
    const service = new LlmTranslationService(client);

    await service.translate({
      text: '你好',
      targetLanguage: 'en',
      model: 'deepseek-v4-flash',
      prompt: { content: '准确翻译。', version: 1 },
      enableThinking: false,
    });

    const body = JSON.parse(String(fetchImplementation.mock.calls[0]?.[1]?.body)) as {
      thinking?: { type: string };
    };
    expect(body.thinking).toEqual({ type: 'disabled' });
  });

  it('sends the enabled thinking toggle to any OpenAI-compatible provider', async () => {
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

    await service.translate({
      text: '你好',
      targetLanguage: 'en',
      model: 'other-model',
      prompt: { content: '准确翻译。', version: 1 },
      enableThinking: true,
    });

    const body = JSON.parse(String(fetchImplementation.mock.calls[0]?.[1]?.body)) as {
      thinking?: { type: string };
    };
    expect(body.thinking).toEqual({ type: 'enabled' });
  });

  it('omits the thinking field when enableThinking is not set', async () => {
    const fetchImplementation = vi.fn(async () =>
      jsonCompletion({
        detectedLanguage: 'zh',
        translatedText: 'Hello',
        confidence: 0.99,
      }),
    );
    const client = new OpenAICompatibleClient({
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'test-key',
      fetchImplementation,
    });
    const service = new LlmTranslationService(client);

    await service.translate({
      text: '你好',
      targetLanguage: 'en',
      model: 'deepseek-v4-flash',
      prompt: { content: '准确翻译。', version: 1 },
    });

    const body = JSON.parse(String(fetchImplementation.mock.calls[0]?.[1]?.body)) as {
      thinking?: unknown;
    };
    expect(body.thinking).toBeUndefined();
  });

  it('sends max_tokens when a cap is configured and omits it otherwise', async () => {
    const fetchImplementation = vi.fn(async () =>
      jsonCompletion({
        detectedLanguage: 'zh',
        translatedText: 'Hello',
        confidence: 0.99,
      }),
    );
    const capped = new OpenAICompatibleClient({
      baseUrl: 'https://llm.example.test/v1',
      apiKey: 'test-key',
      maxTokens: 2048,
      fetchImplementation,
    });
    await new LlmTranslationService(capped).translate({
      text: '你好',
      targetLanguage: 'en',
      model: 'translation-model',
      prompt: { content: '准确翻译。', version: 1 },
    });
    const cappedBody = JSON.parse(String(fetchImplementation.mock.calls[0]?.[1]?.body)) as {
      max_tokens?: number;
    };
    expect(cappedBody.max_tokens).toBe(2048);

    fetchImplementation.mockClear();
    const uncapped = new OpenAICompatibleClient({
      baseUrl: 'https://llm.example.test/v1',
      apiKey: 'test-key',
      fetchImplementation,
    });
    await new LlmTranslationService(uncapped).translate({
      text: '你好',
      targetLanguage: 'en',
      model: 'translation-model',
      prompt: { content: '准确翻译。', version: 1 },
    });
    const uncappedBody = JSON.parse(String(fetchImplementation.mock.calls[0]?.[1]?.body)) as {
      max_tokens?: number;
    };
    expect(uncappedBody.max_tokens).toBeUndefined();
  });

  it('honors explicit structured-output mode and stage temperature', async () => {
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
      responseFormatMode: 'json-schema',
      fetchImplementation,
    });
    await new LlmTranslationService(client).translate({
      text: '你好',
      targetLanguage: 'en',
      model: 'translation-model',
      prompt: { content: '准确翻译。', version: 1 },
      temperature: 0.2,
    });
    const body = JSON.parse(String(fetchImplementation.mock.calls[0]?.[1]?.body)) as {
      temperature?: number;
      response_format?: { type?: string; json_schema?: { strict?: boolean } };
    };
    expect(body.temperature).toBe(0.2);
    expect(body.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { strict: true },
    });
  });

  it('instructs the model to preserve emoji tokens verbatim', async () => {
    const fetchImplementation = vi.fn(async () =>
      jsonCompletion({
        detectedLanguage: 'zh',
        translatedText: '__DISQORD_CUSTOM_EMOJI_0__',
        confidence: 0.99,
      }),
    );
    const client = new OpenAICompatibleClient({
      baseUrl: 'https://llm.example.test/v1',
      apiKey: 'test-key',
      fetchImplementation,
    });
    await new LlmTranslationService(client).translate({
      text: '__DISQORD_CUSTOM_EMOJI_0__',
      targetLanguage: 'en',
      model: 'translation-model',
      prompt: { content: '准确翻译。', version: 1 },
    });
    const body = JSON.parse(String(fetchImplementation.mock.calls[0]?.[1]?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    const fixedSystem = body.messages[0]?.content ?? '';
    expect(fixedSystem).toContain('__DISQORD_CUSTOM_EMOJI');
    expect(fixedSystem).toContain('CQ:face');
    expect(fixedSystem).toContain('原样保留');
    expect(fixedSystem).toContain('机械化翻译');
    expect(fixedSystem).toContain('快，而不是准确');
  });

  it('treats maxTokens as optional in the settings schema', () => {
    const withCap = llmSettingsSchema.parse({
      baseUrl: 'https://llm.example.test/v1',
      translationModel: 'translate',
      moderationModel: 'moderate',
      maxTokens: 4096,
    });
    expect(withCap.providers[0]?.maxTokens).toBe(4096);

    const withoutCap = llmSettingsSchema.parse({
      baseUrl: 'https://llm.example.test/v1',
      translationModel: 'translate',
      moderationModel: 'moderate',
    });
    expect(withoutCap.providers[0]?.maxTokens).toBeUndefined();
    expect(withoutCap.providers[0]).toMatchObject({
      translationEnabled: true,
      moderationEnabled: true,
      imageModerationEnabled: true,
      retryDelayMs: 0,
      responseFormatMode: 'auto',
    });
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
