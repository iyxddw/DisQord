import { randomUUID } from 'node:crypto';

import {
  promptPurposeSchema,
  promptTemplateVersionSchema,
  type PromptTemplateVersion,
} from '@disqord/shared';

const defaults = {
  'translation-system':
    'Translate naturally and accurately. Preserve names, URLs, code, formatting intent, and tone. Do not add explanations.',
  'translation-task':
    'Translate Chinese to English and English to Chinese. For other languages, translate to the requested target language.',
  'moderation-system':
    'Classify content conservatively for harassment, hate, sexual content, violence, self-harm, illegal activity, personal data, and spam.',
  'moderation-rules':
    'Use low/allow for ordinary content, medium/review for ambiguous risk, and high/block for clear severe risk.',
} as const;

export class PromptVersionStore {
  readonly #versions = new Map<string, PromptTemplateVersion[]>();

  createDefaultVersions(administratorId: string): void {
    for (const [purpose, content] of Object.entries(defaults)) {
      if (this.#versions.has(purpose)) continue;
      const now = new Date().toISOString();
      this.#versions.set(purpose, [
        promptTemplateVersionSchema.parse({
          id: randomUUID(),
          purpose,
          version: 1,
          status: 'published',
          content,
          createdBy: administratorId,
          createdAt: now,
          publishedAt: now,
        }),
      ]);
    }
  }

  createDraft(
    purposeCandidate: string,
    content: string,
    administratorId: string,
  ): PromptTemplateVersion {
    const purpose = promptPurposeSchema.parse(purposeCandidate);
    const versions = this.#versions.get(purpose) ?? [];
    const draft = promptTemplateVersionSchema.parse({
      id: randomUUID(),
      purpose,
      version: Math.max(0, ...versions.map((item) => item.version)) + 1,
      status: 'draft',
      content,
      createdBy: administratorId,
      createdAt: new Date().toISOString(),
    });
    versions.push(draft);
    this.#versions.set(purpose, versions);
    return structuredClone(draft);
  }

  publish(id: string): PromptTemplateVersion {
    for (const [purpose, versions] of this.#versions) {
      const target = versions.find((item) => item.id === id);
      if (!target) continue;
      const now = new Date().toISOString();
      const updated = versions.map((item) =>
        item.id === id
          ? promptTemplateVersionSchema.parse({
              ...item,
              status: 'published',
              publishedAt: now,
            })
          : item.status === 'published'
            ? promptTemplateVersionSchema.parse({ ...item, status: 'archived' })
            : item,
      );
      this.#versions.set(purpose, updated);
      return structuredClone(updated.find((item) => item.id === id)!);
    }
    throw new Error(`Unknown prompt version ${id}.`);
  }

  getPublished(purposeCandidate: string): PromptTemplateVersion {
    const purpose = promptPurposeSchema.parse(purposeCandidate);
    const prompt = this.#versions.get(purpose)?.find((version) => version.status === 'published');
    if (!prompt) throw new Error(`No published prompt exists for ${purpose}.`);
    return structuredClone(prompt);
  }

  list(purposeCandidate: string): readonly PromptTemplateVersion[] {
    const purpose = promptPurposeSchema.parse(purposeCandidate);
    return (this.#versions.get(purpose) ?? []).map((item) => structuredClone(item));
  }
}
