import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { normalizeNapCatGroupMessage } from './normalize.js';

const baseEvent = {
  post_type: 'message',
  message_type: 'group',
  message_id: 99,
  self_id: 10000,
  user_id: 20000,
  group_id: 30000,
  time: 1_800_000_000,
  sender: { nickname: 'Alice', card: '群名片' },
};

describe('normalizeNapCatGroupMessage', () => {
  it('normalizes text, image and reply segments', () => {
    const message = normalizeNapCatGroupMessage(
      {
        ...baseEvent,
        message: [
          { type: 'reply', data: { id: '88' } },
          { type: 'text', data: { text: '你好' } },
          {
            type: 'image',
            data: { file: 'photo.png', url: 'https://example.test/photo.png' },
          },
        ],
      },
      randomUUID(),
    );

    expect(message).toMatchObject({
      kind: 'mixed',
      text: '你好',
      replyTo: { sourceMessageId: '88' },
      attachments: [{ mimeType: 'image/png' }],
    });
  });

  it('converts unsupported OneBot segments to the unsupported card kind', () => {
    const message = normalizeNapCatGroupMessage(
      {
        ...baseEvent,
        message: [{ type: 'record', data: { file: 'voice.amr' } }],
      },
      randomUUID(),
    );
    expect(message).toMatchObject({ kind: 'unsupported', unsupportedType: 'record' });
  });

  it('ignores messages produced by the logged-in QQ account', () => {
    expect(
      normalizeNapCatGroupMessage(
        {
          ...baseEvent,
          user_id: baseEvent.self_id,
          message: [{ type: 'text', data: { text: 'self' } }],
        },
        randomUUID(),
      ),
    ).toBeUndefined();
  });

  it('renders QQ mentions with resolved group display names', () => {
    const message = normalizeNapCatGroupMessage(
      {
        ...baseEvent,
        message: [
          { type: 'at', data: { qq: '2678615579' } },
          { type: 'text', data: { text: ' 撤回啥了' } },
        ],
      },
      randomUUID(),
      new Map([['2678615579', '萝卜']]),
    );

    expect(message?.text).toBe('@萝卜 撤回啥了');
  });

  it('removes a QQ mention of the logged-in account from the message body', () => {
    const message = normalizeNapCatGroupMessage(
      {
        ...baseEvent,
        message: [
          { type: 'text', data: { text: '是这样的啊' } },
          { type: 'at', data: { qq: baseEvent.self_id } },
          { type: 'text', data: { text: ' ' } },
        ],
      },
      randomUUID(),
    );

    expect(message?.text).toBe('是这样的啊');
  });

  it('ignores a QQ message that only mentions the logged-in account', () => {
    expect(
      normalizeNapCatGroupMessage(
        {
          ...baseEvent,
          message: [{ type: 'at', data: { qq: baseEvent.self_id } }],
        },
        randomUUID(),
      ),
    ).toBeUndefined();
  });

  it('uses resolved QQ reply details when NapCat can retrieve the referenced message', () => {
    const message = normalizeNapCatGroupMessage(
      {
        ...baseEvent,
        message: [
          { type: 'reply', data: { id: '88' } },
          { type: 'text', data: { text: '测试' } },
        ],
      },
      randomUUID(),
      new Map(),
      new Map([
        [
          '88',
          {
            senderDisplayName: '上一位用户',
            textPreview: '上一条消息',
            imageUrl: 'https://example.test/reply.png',
          },
        ],
      ]),
    );

    expect(message?.replyTo).toMatchObject({
      sourceMessageId: '88',
      senderDisplayName: '上一位用户',
      textPreview: '上一条消息',
      imagePreview: { sourceUrl: 'https://example.test/reply.png' },
    });
  });
});
