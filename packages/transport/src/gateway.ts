import { randomUUID } from 'node:crypto';
import { type Server } from 'node:http';

import { type RawData, WebSocket, WebSocketServer } from 'ws';

import { createPairingRequest, createSecureFrame, type NodeIdentity } from './crypto.js';
import { PairingAuthority, type NodeSession, type PairingAcceptance } from './pairing-authority.js';
import { ReplayGuard } from './replay-guard.js';
import {
  clientWireMessageSchema,
  parseWireJson,
  serverWireMessageSchema,
  type ServerWireMessage,
} from './wire.js';

export interface ReceivedNodeFrame {
  readonly nodeId: string;
  readonly nodeType: 'qq' | 'discord';
  readonly kind: string;
  readonly payload: unknown;
  readonly frameId: string;
}

export interface CentralNodeGatewayOptions {
  readonly server: Server;
  readonly path?: string;
  readonly pairingAuthority: PairingAuthority;
  readonly heartbeatIntervalMs?: number;
  readonly connectionTimeoutMs?: number;
  readonly onPairingAccepted?: (
    acceptance: PairingAcceptance,
    session: NodeSession,
  ) => void | Promise<void>;
  readonly onFrame: (frame: ReceivedNodeFrame) => void | Promise<void>;
}

interface ConnectionContext {
  nodeId?: string;
  nodeType?: 'qq' | 'discord';
  sessionToken?: string;
  replayGuard?: ReplayGuard;
  lastPongAt: number;
}

interface PendingCommand {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export class CentralNodeGateway {
  readonly #webSocketServer: WebSocketServer;
  readonly #authority: PairingAuthority;
  readonly #onFrame: CentralNodeGatewayOptions['onFrame'];
  readonly #onPairingAccepted: CentralNodeGatewayOptions['onPairingAccepted'];
  readonly #connections = new Map<string, WebSocket>();
  readonly #contexts = new Map<string, ConnectionContext>();
  readonly #outboundSequences = new Map<string, number>();
  readonly #processedFrameIds = new Map<string, Set<string>>();
  readonly #pendingCommands = new Map<string, PendingCommand>();
  readonly #heartbeatTimer: NodeJS.Timeout;
  readonly #connectionTimeoutMs: number;

  constructor(options: CentralNodeGatewayOptions) {
    this.#authority = options.pairingAuthority;
    this.#onFrame = options.onFrame;
    this.#onPairingAccepted = options.onPairingAccepted;
    this.#connectionTimeoutMs = options.connectionTimeoutMs ?? 45_000;
    this.#webSocketServer = new WebSocketServer({
      server: options.server,
      path: options.path ?? '/node',
      maxPayload: 8 * 1024 * 1024,
    });
    this.#webSocketServer.on('connection', (socket) => this.#handleConnection(socket));
    this.#heartbeatTimer = setInterval(
      () => this.#heartbeat(),
      options.heartbeatIntervalMs ?? 15_000,
    );
    this.#heartbeatTimer.unref();
  }

  disconnectNode(nodeId: string): boolean {
    const socket = this.#connections.get(nodeId);
    if (!socket) {
      return false;
    }
    socket.terminate();
    return true;
  }

  isNodeConnected(nodeId: string): boolean {
    return this.#connections.get(nodeId)?.readyState === WebSocket.OPEN;
  }

  async sendToNode(
    nodeId: string,
    kind: string,
    payload: unknown,
    acknowledgementTimeoutMs = 10_000,
  ): Promise<void> {
    const socket = this.#connections.get(nodeId);
    const context = this.#contexts.get(nodeId);
    if (
      !socket ||
      socket.readyState !== WebSocket.OPEN ||
      !context?.sessionToken ||
      !context.nodeId
    ) {
      throw new Error(`Node ${nodeId} is offline.`);
    }
    const sequence = (this.#outboundSequences.get(nodeId) ?? 0) + 1;
    this.#outboundSequences.set(nodeId, sequence);
    const frame = createSecureFrame(
      {
        frameId: randomUUID(),
        nodeId,
        sequence,
        createdAt: new Date().toISOString(),
        kind,
        payload,
      },
      context.sessionToken,
    );
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingCommands.delete(frame.frameId);
        reject(new Error(`Node command acknowledgement timed out: ${frame.frameId}`));
      }, acknowledgementTimeoutMs);
      timer.unref();
      this.#pendingCommands.set(frame.frameId, { resolve, reject, timer });
      this.#send(socket, { type: 'command', frame });
    });
  }

  async close(): Promise<void> {
    clearInterval(this.#heartbeatTimer);
    for (const socket of this.#connections.values()) {
      socket.close(1001, 'Server shutting down');
    }
    await new Promise<void>((resolve, reject) => {
      this.#webSocketServer.close((error) => (error ? reject(error) : resolve()));
    });
  }

  #handleConnection(socket: WebSocket): void {
    const context: ConnectionContext = { lastPongAt: Date.now() };
    const trackedSocket = socket as WebSocket & { lastPongAt: number };
    trackedSocket.lastPongAt = context.lastPongAt;
    socket.on('pong', () => {
      context.lastPongAt = Date.now();
      trackedSocket.lastPongAt = context.lastPongAt;
    });
    socket.on('message', (data) => {
      void this.#handleMessage(socket, context, data).catch((error: unknown) => {
        this.#send(socket, {
          type: 'error',
          code: 'PROTOCOL_ERROR',
          message: error instanceof Error ? error.message : 'Protocol processing failed.',
        });
      });
    });
    socket.on('close', () => {
      if (context.nodeId && this.#connections.get(context.nodeId) === socket) {
        this.#connections.delete(context.nodeId);
        this.#contexts.delete(context.nodeId);
      }
    });
    socket.on('error', () => {
      // The close handler performs connection cleanup.
    });
  }

  async #handleMessage(
    socket: WebSocket,
    context: ConnectionContext,
    data: RawData,
  ): Promise<void> {
    const message = clientWireMessageSchema.parse(parseWireJson(data));

    if (message.type === 'pair.request') {
      if (context.nodeId) {
        throw new Error('An authenticated connection cannot pair again.');
      }
      const accepted = message.request.pairingCode
        ? this.#authority.accept(message.request)
        : this.#authority.register(message.request);
      const session = this.#authority.getSession(accepted.nodeId);
      if (!session) throw new Error('Accepted node session was not created.');
      await this.#onPairingAccepted?.(accepted, session);
      this.#send(socket, {
        type: 'pair.accepted',
        nodeId: accepted.nodeId,
        sessionToken: accepted.sessionToken,
        publicKeyFingerprint: accepted.publicKeyFingerprint,
      });
      socket.close(1000, 'Pairing complete');
      return;
    }

    if (message.type === 'auth.request') {
      const session = this.#authority.authenticate(
        message.nodeId,
        message.nodeType,
        message.sessionToken,
      );
      const existing = this.#connections.get(session.nodeId);
      if (existing && existing !== socket) {
        existing.close(4001, 'Replaced by a newer authenticated connection');
      }
      context.nodeId = session.nodeId;
      context.nodeType = session.nodeType;
      context.sessionToken = message.sessionToken;
      context.replayGuard = new ReplayGuard(
        session.nodeId,
        message.sessionToken,
        Date.now,
        2 * 60 * 1_000,
        0,
      );
      this.#connections.set(session.nodeId, socket);
      this.#contexts.set(session.nodeId, context);
      this.#send(socket, { type: 'auth.accepted', nodeId: session.nodeId });
      return;
    }

    if (message.type === 'command.ack') {
      if (!context.nodeId) {
        throw new Error('The connection must authenticate before acknowledging commands.');
      }
      const pending = this.#pendingCommands.get(message.frameId);
      if (pending) {
        clearTimeout(pending.timer);
        this.#pendingCommands.delete(message.frameId);
        pending.resolve();
      }
      return;
    }

    if (!context.nodeId || !context.nodeType || !context.replayGuard) {
      throw new Error('The connection must authenticate before sending frames.');
    }

    const processed = this.#processedFrameIds.get(context.nodeId);
    if (processed?.has(message.frame.frameId)) {
      this.#send(socket, { type: 'frame.ack', frameId: message.frame.frameId });
      return;
    }

    context.replayGuard.verify(message.frame);
    await this.#onFrame({
      nodeId: context.nodeId,
      nodeType: context.nodeType,
      kind: message.frame.kind,
      payload: message.frame.payload,
      frameId: message.frame.frameId,
    });
    this.#rememberFrame(context.nodeId, message.frame.frameId);
    this.#send(socket, { type: 'frame.ack', frameId: message.frame.frameId });
  }

  #rememberFrame(nodeId: string, frameId: string): void {
    const frames = this.#processedFrameIds.get(nodeId) ?? new Set<string>();
    frames.add(frameId);
    while (frames.size > 10_000) {
      const oldest = frames.values().next().value as string | undefined;
      if (!oldest) break;
      frames.delete(oldest);
    }
    this.#processedFrameIds.set(nodeId, frames);
  }

  #heartbeat(): void {
    const now = Date.now();
    for (const [nodeId, socket] of this.#connections) {
      const contextSocket = socket as WebSocket & { lastPongAt: number };
      if (
        contextSocket.readyState !== WebSocket.OPEN ||
        now - contextSocket.lastPongAt > this.#connectionTimeoutMs
      ) {
        socket.terminate();
        this.#connections.delete(nodeId);
        continue;
      }
      socket.ping();
    }
  }

  #send(socket: WebSocket, message: ServerWireMessage): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(serverWireMessageSchema.parse(message)));
    }
  }
}

export interface AuthenticatedNodeClientOptions {
  readonly url: string;
  readonly identity: NodeIdentity;
  readonly sessionToken: string;
  readonly allowInsecure?: boolean;
  readonly reconnectBaseDelayMs?: number;
  readonly reconnectMaxDelayMs?: number;
  readonly acknowledgementTimeoutMs?: number;
  readonly onConnected?: () => void;
  readonly onCommand?: (command: {
    readonly kind: string;
    readonly payload: unknown;
    readonly frameId: string;
  }) => void | Promise<void>;
}

interface PendingAcknowledgement {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export class AuthenticatedNodeClient {
  readonly #options: AuthenticatedNodeClientOptions;
  readonly #pending = new Map<string, PendingAcknowledgement>();
  readonly #processedCommands = new Set<string>();
  #commandReplayGuard: ReplayGuard | undefined;
  #socket: WebSocket | undefined;
  #sequence = 0;
  #manualClose = false;
  #reconnectAttempt = 0;
  #connectPromise: Promise<void> | undefined;

  constructor(options: AuthenticatedNodeClientOptions) {
    assertSecureUrl(options.url, options.allowInsecure ?? false);
    this.#options = options;
  }

  static async pair(input: {
    readonly url: string;
    readonly identity: NodeIdentity;
    readonly pairingCode?: string;
    readonly allowInsecure?: boolean;
  }): Promise<string> {
    assertSecureUrl(input.url, input.allowInsecure ?? false);
    const socket = new WebSocket(input.url);
    return await new Promise<string>((resolve, reject) => {
      const fail = (error: Error) => {
        socket.close();
        reject(error);
      };
      socket.once('open', () => {
        socket.send(
          JSON.stringify({
            type: 'pair.request',
            request: createPairingRequest(input.identity, input.pairingCode),
          }),
        );
      });
      socket.on('message', (data) => {
        try {
          const message = serverWireMessageSchema.parse(parseWireJson(data));
          if (message.type === 'pair.accepted') {
            resolve(message.sessionToken);
            socket.close();
          } else if (message.type === 'error') {
            fail(new Error(message.message));
          }
        } catch (error) {
          fail(error instanceof Error ? error : new Error('Invalid pairing response.'));
        }
      });
      socket.once('error', fail);
    });
  }

  async connect(): Promise<void> {
    this.#manualClose = false;
    this.#connectPromise ??= this.#open();
    try {
      await this.#connectPromise;
    } finally {
      this.#connectPromise = undefined;
    }
  }

  async send(kind: string, payload: unknown, maxAttempts = 3): Promise<void> {
    await this.connect();
    this.#sequence += 1;
    const frame = createSecureFrame(
      {
        frameId: randomUUID(),
        nodeId: this.#options.identity.nodeId,
        sequence: this.#sequence,
        createdAt: new Date().toISOString(),
        kind,
        payload,
      },
      this.#options.sessionToken,
    );

    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.#sendFrame(frame);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Frame delivery failed.');
        if (attempt < maxAttempts) {
          await this.connect();
        }
      }
    }
    throw lastError ?? new Error('Frame delivery failed.');
  }

  disconnect(): void {
    this.#manualClose = true;
    this.#socket?.close(1000, 'Client disconnect');
    this.#socket = undefined;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Node client disconnected.'));
    }
    this.#pending.clear();
  }

  #open(): Promise<void> {
    if (this.#socket?.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.#options.url);
      this.#socket = socket;
      let authenticated = false;

      socket.once('open', () => {
        socket.send(
          JSON.stringify({
            type: 'auth.request',
            nodeId: this.#options.identity.nodeId,
            nodeType: this.#options.identity.nodeType,
            sessionToken: this.#options.sessionToken,
          }),
        );
      });
      socket.on('message', (data) => {
        try {
          const message = serverWireMessageSchema.parse(parseWireJson(data));
          if (message.type === 'auth.accepted') {
            authenticated = true;
            this.#commandReplayGuard = new ReplayGuard(
              this.#options.identity.nodeId,
              this.#options.sessionToken,
            );
            this.#reconnectAttempt = 0;
            this.#options.onConnected?.();
            resolve();
          } else if (message.type === 'frame.ack') {
            const pending = this.#pending.get(message.frameId);
            if (pending) {
              clearTimeout(pending.timer);
              this.#pending.delete(message.frameId);
              pending.resolve();
            }
          } else if (message.type === 'command') {
            void this.#handleCommand(socket, message.frame);
          } else if (message.type === 'error' && !authenticated) {
            reject(new Error(message.message));
            socket.close();
          }
        } catch (error) {
          if (!authenticated) {
            reject(error instanceof Error ? error : new Error('Invalid gateway response.'));
          }
        }
      });
      socket.once('error', (error) => {
        if (!authenticated) reject(error);
      });
      socket.once('close', () => {
        if (this.#socket === socket) this.#socket = undefined;
        if (!authenticated) reject(new Error('Gateway closed before authentication.'));
        if (!this.#manualClose) this.#scheduleReconnect();
      });
    });
  }

  #sendFrame(frame: ReturnType<typeof createSecureFrame>): Promise<void> {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Gateway connection is not open.'));
    }

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(frame.frameId);
        reject(new Error(`Acknowledgement timed out for frame ${frame.frameId}.`));
      }, this.#options.acknowledgementTimeoutMs ?? 10_000);
      timer.unref();
      this.#pending.set(frame.frameId, { resolve, reject, timer });
      socket.send(JSON.stringify({ type: 'frame', frame }), (error) => {
        if (error) {
          clearTimeout(timer);
          this.#pending.delete(frame.frameId);
          reject(error);
        }
      });
    });
  }

  async #handleCommand(
    socket: WebSocket,
    frame: ReturnType<typeof createSecureFrame>,
  ): Promise<void> {
    if (this.#processedCommands.has(frame.frameId)) {
      socket.send(JSON.stringify({ type: 'command.ack', frameId: frame.frameId }));
      return;
    }
    if (!this.#commandReplayGuard) {
      throw new Error('Node client received a command before authentication.');
    }
    this.#commandReplayGuard.verify(frame);
    await this.#options.onCommand?.({
      kind: frame.kind,
      payload: frame.payload,
      frameId: frame.frameId,
    });
    this.#processedCommands.add(frame.frameId);
    while (this.#processedCommands.size > 10_000) {
      const oldest = this.#processedCommands.values().next().value as string | undefined;
      if (!oldest) break;
      this.#processedCommands.delete(oldest);
    }
    socket.send(JSON.stringify({ type: 'command.ack', frameId: frame.frameId }));
  }

  #scheduleReconnect(): void {
    this.#reconnectAttempt += 1;
    const base = this.#options.reconnectBaseDelayMs ?? 500;
    const maximum = this.#options.reconnectMaxDelayMs ?? 30_000;
    const exponential = Math.min(maximum, base * 2 ** (this.#reconnectAttempt - 1));
    const delay = Math.round(exponential * (0.8 + Math.random() * 0.4));
    const timer = setTimeout(() => {
      if (!this.#manualClose) void this.connect().catch(() => this.#scheduleReconnect());
    }, delay);
    timer.unref();
  }
}

function assertSecureUrl(url: string, allowInsecure: boolean): void {
  const parsed = new URL(url);
  if (parsed.protocol !== 'wss:' && !(allowInsecure && parsed.protocol === 'ws:')) {
    throw new Error('Production node connections require a wss:// URL.');
  }
}
