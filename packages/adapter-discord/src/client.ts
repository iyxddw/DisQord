import {
  AttachmentBuilder,
  Client,
  Events,
  GatewayIntentBits,
  Options,
  PermissionFlagsBits,
  type Message,
} from 'discord.js';

import { normalizeDiscordMessage, type DiscordMessageSnapshot } from './normalize.js';

export interface DiscordAdapterOptions {
  readonly token: string;
  readonly nodeId: string;
  readonly onMessage: (
    message: NonNullable<ReturnType<typeof normalizeDiscordMessage>>,
  ) => void | Promise<void>;
}

export interface DiscordChatChannel {
  readonly id: string;
  readonly guildId: string;
  readonly guildName: string;
  readonly name: string;
}

export class DiscordBotAdapter {
  readonly #options: DiscordAdapterOptions;
  readonly #client: Client;

  constructor(options: DiscordAdapterOptions) {
    this.#options = options;
    this.#client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      makeCache: Options.cacheWithLimits({
        MessageManager: 0,
        GuildMemberManager: 0,
        PresenceManager: 0,
        ReactionManager: 0,
        ThreadManager: 0,
        ThreadMemberManager: 0,
        VoiceStateManager: 0,
        UserManager: 1_000,
      }),
      sweepers: {
        messages: { interval: 300, lifetime: 600 },
      },
    });
    this.#client.on(Events.MessageCreate, (message) => {
      void this.#handleMessage(message).catch((error: unknown) => {
        console.error('[DisQord/Discord] message handling failed', error);
      });
    });
  }

  async start(): Promise<void> {
    await this.#client.login(this.#options.token);
  }

  async stop(): Promise<void> {
    this.#client.destroy();
  }

  isReady(): boolean {
    return this.#client.isReady();
  }

  async listChannels(): Promise<DiscordChatChannel[]> {
    if (!this.#client.user) return [];
    const result: DiscordChatChannel[] = [];
    for (const guild of this.#client.guilds.cache.values()) {
      const channels = await guild.channels.fetch();
      for (const channel of channels.values()) {
        if (!channel?.isTextBased() || !channel.isSendable()) continue;
        const permissions = channel.permissionsFor(this.#client.user);
        if (
          !permissions?.has(PermissionFlagsBits.ViewChannel) ||
          !permissions.has(PermissionFlagsBits.SendMessages)
        ) {
          continue;
        }
        result.push({
          id: channel.id,
          guildId: guild.id,
          guildName: guild.name,
          name: (channel as { name?: string }).name ?? channel.id,
        });
      }
    }
    return result.sort((left, right) =>
      `${left.guildName}/${left.name}`.localeCompare(`${right.guildName}/${right.name}`),
    );
  }

  async sendVerificationCode(channelId: string, code: string, expiresAt: string): Promise<string> {
    const channel = await this.#client.channels.fetch(channelId);
    if (!channel?.isSendable()) {
      throw new Error(`Discord channel ${channelId} is not sendable by this bot.`);
    }
    const message = await channel.send({
      content: `DisQord 会话验证码：\`${code}\`\n有效期至：${expiresAt}`,
      allowedMentions: { parse: [] },
    });
    return message.id;
  }

  async sendRenderedCard(
    channelId: string,
    png: Uint8Array,
    replyMessageId?: string,
  ): Promise<string> {
    const channel = await this.#client.channels.fetch(channelId);
    if (!channel?.isSendable()) {
      throw new Error(`Discord channel ${channelId} is not sendable by this bot.`);
    }
    const message = await channel.send({
      files: [new AttachmentBuilder(Buffer.from(png), { name: 'disqord-message.png' })],
      allowedMentions: { parse: [] },
      ...(replyMessageId
        ? { reply: { messageReference: replyMessageId, failIfNotExists: false } }
        : {}),
    });
    return message.id;
  }

  async sendText(channelId: string, text: string, replyMessageId?: string): Promise<string> {
    const channel = await this.#client.channels.fetch(channelId);
    if (!channel?.isSendable()) {
      throw new Error(`Discord channel ${channelId} is not sendable by this bot.`);
    }
    const message = await channel.send({
      content: text,
      allowedMentions: { parse: [] },
      ...(replyMessageId
        ? { reply: { messageReference: replyMessageId, failIfNotExists: false } }
        : {}),
    });
    return message.id;
  }

  async #handleMessage(message: Message): Promise<void> {
    if (!message.guildId) return;
    const referenced = message.reference?.messageId
      ? await message.fetchReference().catch(() => undefined)
      : undefined;
    const firstReferencedImage = referenced?.attachments.find((attachment) =>
      attachment.contentType?.startsWith('image/'),
    );
    const snapshot: DiscordMessageSnapshot = {
      id: message.id,
      guildId: message.guildId,
      channelId: message.channelId,
      createdAt: message.createdAt.toISOString(),
      content: message.content,
      type: message.type,
      author: {
        id: message.author.id,
        displayName: message.member?.displayName ?? message.author.displayName,
        avatarUrl: message.author.displayAvatarURL({ size: 256 }),
        bot: message.author.bot,
      },
      attachments: message.attachments.map((attachment) => ({
        id: attachment.id,
        name: attachment.name,
        contentType: attachment.contentType,
        size: attachment.size,
        url: attachment.url,
        width: attachment.width,
        height: attachment.height,
      })),
      stickerCount: message.stickers.size,
      ...(referenced
        ? {
            referencedMessage: {
              id: referenced.id,
              authorDisplayName: referenced.member?.displayName ?? referenced.author.displayName,
              content: referenced.content,
              ...(firstReferencedImage ? { imageUrl: firstReferencedImage.url } : {}),
            },
          }
        : message.reference?.messageId
          ? { referencedMessageId: message.reference.messageId }
          : {}),
    };
    const normalized = normalizeDiscordMessage(snapshot, this.#options.nodeId);
    if (normalized) await this.#options.onMessage(normalized);
  }
}
