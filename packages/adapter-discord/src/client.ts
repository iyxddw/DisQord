import {
  AttachmentBuilder,
  Client,
  Events,
  GatewayIntentBits,
  Options,
  PermissionFlagsBits,
  type Message,
} from 'discord.js';

import {
  normalizeDiscordMessage,
  type DiscordMention,
  type DiscordMessageSnapshot,
} from './normalize.js';

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
    let visibleTextChannels = 0;
    let deniedTextChannels = 0;
    let guildFetchErrors = 0;
    for (const guild of this.#client.guilds.cache.values()) {
      const channels = await guild.channels.fetch().catch((error: unknown) => {
        guildFetchErrors += 1;
        console.warn(
          `[DisQord/Discord] failed to inspect guild ${guild.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return undefined;
      });
      if (!channels) continue;
      for (const channel of channels.values()) {
        if (!channel?.isTextBased()) continue;
        visibleTextChannels += 1;
        const permissions = channel.permissionsFor(this.#client.user);
        if (
          !channel.isSendable() ||
          !permissions?.has(PermissionFlagsBits.ViewChannel) ||
          !permissions.has(PermissionFlagsBits.SendMessages)
        ) {
          deniedTextChannels += 1;
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
    const sorted = result.sort((left, right) =>
      `${left.guildName}/${left.name}`.localeCompare(`${right.guildName}/${right.name}`),
    );
    if (!sorted.length) {
      console.warn(
        `[DisQord/Discord] no bindable channels discovered (guilds=${this.#client.guilds.cache.size}, ` +
          `visibleTextChannels=${visibleTextChannels}, denied=${deniedTextChannels}, ` +
          `guildFetchErrors=${guildFetchErrors}); ` +
          'check bot membership and View Channel/Send Messages permissions',
      );
    }
    return sorted;
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
    const [mentions, referencedMentions] = await Promise.all([
      this.#resolveMentionNames(message),
      referenced ? this.#resolveMentionNames(referenced) : Promise.resolve(undefined),
    ]);
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
      mentions,
      ...(referenced
        ? {
            referencedMessage: {
              id: referenced.id,
              authorDisplayName: referenced.member?.displayName ?? referenced.author.displayName,
              content: referenced.content,
              mentions: referencedMentions,
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

  async #resolveMentionNames(message: Message): Promise<DiscordMention[]> {
    return await Promise.all(
      [...message.mentions.users.values()].map(async (user) => {
        let member = message.mentions.members?.get(user.id);
        if (!member && message.guild) {
          member = await message.guild.members.fetch(user.id).catch(() => undefined);
        }
        return {
          id: user.id,
          displayName: member?.displayName ?? user.globalName ?? user.username,
        };
      }),
    );
  }
}
