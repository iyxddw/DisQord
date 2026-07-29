import { randomUUID } from 'node:crypto';

import { type MessageEnvelope, type Platform } from '@disqord/shared';
import { describe, expect, it } from 'vitest';

import { CentralSimulator, SimulatedPlatformNode } from './simulation.js';

function createTextMessage(input: {
  nodeId: string;
  platform: Platform;
  channelId: string;
  messageId: string;
  text: string;
  replyTo?: MessageEnvelope['replyTo'];
}): MessageEnvelope {
  return {
    schemaVersion: 1,
    eventId: randomUUID(),
    source: {
      nodeId: input.nodeId,
      platform: input.platform,
      spaceId: input.channelId,
      channelId: input.channelId,
      messageId: input.messageId,
    },
    sender: {
      id: `${input.platform}-user`,
      displayName: `${input.platform.toUpperCase()} User`,
    },
    sentAt: new Date().toISOString(),
    kind: 'text',
    text: input.text,
    attachments: [],
    replyTo: input.replyTo,
    traceId: randomUUID(),
  };
}

function createConnectedSimulation() {
  const central = new CentralSimulator();
  const qq = new SimulatedPlatformNode(randomUUID(), 'qq');
  const discord = new SimulatedPlatformNode(randomUUID(), 'discord');
  qq.connect(central);
  discord.connect(central);
  central.addRoute({
    sourcePlatform: 'qq',
    sourceChannelId: 'qq-group-1',
    targetPlatform: 'discord',
    targetChannelId: 'discord-channel-1',
  });
  central.addRoute({
    sourcePlatform: 'discord',
    sourceChannelId: 'discord-channel-1',
    targetPlatform: 'qq',
    targetChannelId: 'qq-group-1',
  });
  return { central, qq, discord };
}

describe('central-only simulated message flow', () => {
  it('forwards QQ and Discord messages in both directions through central', () => {
    const { qq, discord } = createConnectedSimulation();

    expect(
      qq.publish(
        createTextMessage({
          nodeId: qq.nodeId,
          platform: 'qq',
          channelId: 'qq-group-1',
          messageId: 'qq-message-1',
          text: '你好',
        }),
      ),
    ).toEqual({ status: 'accepted', deliveries: 1 });
    expect(discord.deliveries()[0]).toMatchObject({
      targetChannelId: 'discord-channel-1',
      message: { text: '你好' },
    });

    expect(
      discord.publish(
        createTextMessage({
          nodeId: discord.nodeId,
          platform: 'discord',
          channelId: 'discord-channel-1',
          messageId: 'discord-message-1',
          text: 'Hello',
        }),
      ),
    ).toEqual({ status: 'accepted', deliveries: 1 });
    expect(qq.deliveries()[0]).toMatchObject({
      targetChannelId: 'qq-group-1',
      message: { text: 'Hello' },
    });
  });

  it('preserves reply context across the central route', () => {
    const { qq, discord } = createConnectedSimulation();
    const message = createTextMessage({
      nodeId: discord.nodeId,
      platform: 'discord',
      channelId: 'discord-channel-1',
      messageId: 'discord-reply-1',
      text: 'This is a reply',
      replyTo: {
        sourceMessageId: 'discord-original-1',
        senderDisplayName: 'Original sender',
        textPreview: 'Original message',
      },
    });

    discord.publish(message);

    expect(qq.deliveries()[0]?.message.replyTo).toEqual(message.replyTo);
  });

  it('does not deliver a duplicate platform event twice', () => {
    const { qq, discord } = createConnectedSimulation();
    const message = createTextMessage({
      nodeId: qq.nodeId,
      platform: 'qq',
      channelId: 'qq-group-1',
      messageId: 'same-platform-message',
      text: 'Only once',
    });

    expect(qq.publish(message).status).toBe('accepted');
    expect(qq.publish({ ...message, eventId: randomUUID(), traceId: randomUUID() })).toEqual({
      status: 'duplicate',
      deliveries: 0,
    });
    expect(discord.deliveries()).toHaveLength(1);
  });

  it('rejects a message claiming to be from another node', () => {
    const { qq, discord } = createConnectedSimulation();
    const forged = createTextMessage({
      nodeId: discord.nodeId,
      platform: 'qq',
      channelId: 'qq-group-1',
      messageId: 'forged',
      text: 'forged source',
    });

    expect(() => qq.publish(forged)).toThrow('does not match the authenticated platform node');
  });

  it('does not allow publishing before a central connection exists', () => {
    const qq = new SimulatedPlatformNode(randomUUID(), 'qq');
    const message = createTextMessage({
      nodeId: qq.nodeId,
      platform: 'qq',
      channelId: 'qq-group-1',
      messageId: 'offline',
      text: 'offline',
    });

    expect(() => qq.publish(message)).toThrow('not connected to the central server');
  });
});
