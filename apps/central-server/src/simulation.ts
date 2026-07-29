import {
  createMessageIdempotencyKey,
  messageEnvelopeSchema,
  platformSchema,
  type MessageEnvelope,
  type Platform,
} from '@disqord/shared';

export interface SimulationRoute {
  readonly sourcePlatform: Platform;
  readonly sourceChannelId: string;
  readonly targetPlatform: Platform;
  readonly targetChannelId: string;
}

export interface SimulatedDelivery {
  readonly targetChannelId: string;
  readonly message: MessageEnvelope;
}

export interface IngestResult {
  readonly status: 'accepted' | 'duplicate' | 'unmatched';
  readonly deliveries: number;
}

interface RegisteredNode {
  readonly nodeId: string;
  readonly platform: Platform;
  readonly deliver: (delivery: SimulatedDelivery) => void;
}

export class CentralSimulator {
  readonly #nodes = new Map<Platform, RegisteredNode>();
  readonly #routes: SimulationRoute[] = [];
  readonly #seenMessages = new Set<string>();

  registerNode(node: RegisteredNode): (message: MessageEnvelope) => IngestResult {
    const platform = platformSchema.parse(node.platform);
    if (this.#nodes.has(platform)) {
      throw new Error(`A simulated ${platform} node is already connected.`);
    }

    this.#nodes.set(platform, node);
    return (message) => this.#ingest(node, message);
  }

  addRoute(route: SimulationRoute): void {
    platformSchema.parse(route.sourcePlatform);
    platformSchema.parse(route.targetPlatform);

    if (route.sourcePlatform === route.targetPlatform) {
      throw new Error('Stage 1 simulation routes must cross platforms.');
    }

    this.#routes.push({ ...route });
  }

  #ingest(sourceNode: RegisteredNode, candidate: MessageEnvelope): IngestResult {
    const message = messageEnvelopeSchema.parse(candidate);

    if (
      message.source.nodeId !== sourceNode.nodeId ||
      message.source.platform !== sourceNode.platform
    ) {
      throw new Error('Message source does not match the authenticated platform node.');
    }

    const idempotencyKey = createMessageIdempotencyKey(message);
    if (this.#seenMessages.has(idempotencyKey)) {
      return { status: 'duplicate', deliveries: 0 };
    }
    this.#seenMessages.add(idempotencyKey);

    const matchingRoutes = this.#routes.filter(
      (route) =>
        route.sourcePlatform === sourceNode.platform &&
        route.sourceChannelId === message.source.channelId,
    );

    let deliveries = 0;
    for (const route of matchingRoutes) {
      const targetNode = this.#nodes.get(route.targetPlatform);
      if (!targetNode) {
        continue;
      }

      targetNode.deliver({
        targetChannelId: route.targetChannelId,
        message,
      });
      deliveries += 1;
    }

    return {
      status: deliveries > 0 ? 'accepted' : 'unmatched',
      deliveries,
    };
  }
}

export class SimulatedPlatformNode {
  readonly #deliveries: SimulatedDelivery[] = [];
  #uploadToCentral?: (message: MessageEnvelope) => IngestResult;

  constructor(
    readonly nodeId: string,
    readonly platform: Platform,
  ) {}

  connect(central: CentralSimulator): void {
    if (this.#uploadToCentral) {
      throw new Error('The simulated node is already connected.');
    }

    this.#uploadToCentral = central.registerNode({
      nodeId: this.nodeId,
      platform: this.platform,
      deliver: (delivery) => {
        this.#deliveries.push(delivery);
      },
    });
  }

  publish(message: MessageEnvelope): IngestResult {
    if (!this.#uploadToCentral) {
      throw new Error('The simulated node is not connected to the central server.');
    }

    return this.#uploadToCentral(message);
  }

  deliveries(): readonly SimulatedDelivery[] {
    return this.#deliveries.map((delivery) => ({
      ...delivery,
      message: structuredClone(delivery.message),
    }));
  }
}
