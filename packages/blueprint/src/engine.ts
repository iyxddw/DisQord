import {
  blueprintVersionSchema,
  internalIdSchema,
  messageKindSchema,
  type BlueprintNode,
  type BlueprintVersion,
  type MessageEnvelope,
} from '@disqord/shared';
import { z } from 'zod';

const chatNodeConfigSchema = z.object({ sessionId: internalIdSchema });
const messageTypeFilterConfigSchema = z.object({
  allowedKinds: z.array(messageKindSchema).min(1),
});
const textConditionConfigSchema = z.object({
  contains: z.string().min(1).max(1_000),
  caseSensitive: z.boolean().default(false),
});
const translationConfigSchema = z.object({
  prompt: z.string().trim().min(1).max(50_000),
  memoryMode: z.boolean().default(false),
  enableThinking: z.boolean().default(false),
});
const moderationConfigSchema = z.object({
  prompt: z.string().trim().min(1).max(50_000),
  threshold: z.number().min(0).max(1),
  enableThinking: z.boolean().default(false),
});
const fixedTextConfigSchema = z.object({ text: z.string().max(30_000) });

export interface BlueprintValidationError {
  readonly code: string;
  readonly message: string;
  readonly nodeId?: string;
  readonly edgeId?: string;
}

export interface BlueprintValidationResult {
  readonly valid: boolean;
  readonly errors: readonly BlueprintValidationError[];
  readonly topologicalOrder: readonly string[];
}

export interface BlueprintValidationContext {
  readonly isVerifiedSession: (sessionId: string) => boolean;
}

export function validateBlueprint(
  candidate: BlueprintVersion,
  context: BlueprintValidationContext,
): BlueprintValidationResult {
  const blueprint = blueprintVersionSchema.parse(candidate);
  const errors: BlueprintValidationError[] = [];
  const nodes = new Map<string, BlueprintNode>();
  for (const node of blueprint.nodes) {
    if (nodes.has(node.id)) {
      errors.push({ code: 'DUPLICATE_NODE', message: 'Node ID is duplicated.', nodeId: node.id });
    }
    nodes.set(node.id, node);
    if (node.type === 'chat-input' || node.type === 'chat-output') {
      const config = chatNodeConfigSchema.safeParse(node.config);
      if (!config.success) {
        errors.push({
          code: 'INVALID_CHAT_NODE',
          message: 'Chat nodes require a sessionId.',
          nodeId: node.id,
        });
      } else if (!context.isVerifiedSession(config.data.sessionId)) {
        errors.push({
          code: 'UNVERIFIED_SESSION',
          message: 'Chat node references an unverified session.',
          nodeId: node.id,
        });
      }
    } else if (node.type === 'llm-translation') {
      if (!translationConfigSchema.safeParse(node.config).success) {
        errors.push({
          code: 'INVALID_TRANSLATION_NODE',
          message: 'Translation nodes require a prompt and memoryMode.',
          nodeId: node.id,
        });
      }
    } else if (node.type === 'llm-moderation') {
      if (!moderationConfigSchema.safeParse(node.config).success) {
        errors.push({
          code: 'INVALID_MODERATION_NODE',
          message: 'Moderation nodes require a prompt and threshold from 0 to 1.',
          nodeId: node.id,
        });
      }
    } else if (node.type === 'fixed-text') {
      if (!fixedTextConfigSchema.safeParse(node.config).success) {
        errors.push({
          code: 'INVALID_FIXED_TEXT_NODE',
          message: 'Fixed-text nodes require text.',
          nodeId: node.id,
        });
      }
    }
  }

  const outgoing = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const nodeId of nodes.keys()) {
    outgoing.set(nodeId, []);
    indegree.set(nodeId, 0);
  }
  for (const edge of blueprint.edges) {
    if (!nodes.has(edge.sourceNodeId) || !nodes.has(edge.targetNodeId)) {
      errors.push({
        code: 'DANGLING_EDGE',
        message: 'Edge references a missing node.',
        edgeId: edge.id,
      });
      continue;
    }
    const source = nodes.get(edge.sourceNodeId);
    if (
      (source?.type === 'llm-moderation' || source?.type === 'manual-review') &&
      edge.sourceHandle !== 'passed' &&
      edge.sourceHandle !== 'blocked'
    ) {
      errors.push({
        code:
          source.type === 'manual-review'
            ? 'INVALID_MANUAL_REVIEW_EDGE'
            : 'INVALID_MODERATION_EDGE',
        message: `${source.type === 'manual-review' ? 'Manual review' : 'Moderation'} edges must use the passed or blocked output.`,
        edgeId: edge.id,
      });
    }
    outgoing.get(edge.sourceNodeId)!.push(edge.targetNodeId);
    indegree.set(edge.targetNodeId, (indegree.get(edge.targetNodeId) ?? 0) + 1);
  }

  const inputs = blueprint.nodes.filter(
    (node) => node.type === 'chat-input' || node.type === 'simulated-input',
  );
  const outputs = blueprint.nodes.filter(
    (node) => node.type === 'chat-output' || node.type === 'simulated-output',
  );
  if (!inputs.length) errors.push({ code: 'NO_INPUT', message: 'Blueprint requires an input.' });
  if (!outputs.length) errors.push({ code: 'NO_OUTPUT', message: 'Blueprint requires an output.' });

  const queue = [...indegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([nodeId]) => nodeId);
  const topologicalOrder: string[] = [];
  while (queue.length) {
    const nodeId = queue.shift()!;
    topologicalOrder.push(nodeId);
    for (const target of outgoing.get(nodeId) ?? []) {
      const next = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, next);
      if (next === 0) queue.push(target);
    }
  }
  if (topologicalOrder.length !== nodes.size) {
    errors.push({ code: 'CYCLE', message: 'Blueprint must not contain a cycle.' });
  }

  return {
    valid: errors.length === 0,
    errors,
    topologicalOrder,
  };
}

export interface BlueprintExecutionResult {
  readonly outputSessionIds: readonly string[];
  readonly visitedNodeIds: readonly string[];
}

export function simulateBlueprint(
  blueprint: BlueprintVersion,
  inputSessionId: string,
  message: MessageEnvelope,
  context: BlueprintValidationContext,
): BlueprintExecutionResult {
  const validation = validateBlueprint(blueprint, context);
  if (!validation.valid) {
    throw new Error(
      `Blueprint is invalid: ${validation.errors.map((error) => error.code).join(', ')}`,
    );
  }
  const nodes = new Map(blueprint.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, string[]>();
  for (const edge of blueprint.edges) {
    const targets = outgoing.get(edge.sourceNodeId) ?? [];
    targets.push(edge.targetNodeId);
    outgoing.set(edge.sourceNodeId, targets);
  }
  const starts = blueprint.nodes.filter(
    (node) =>
      node.type === 'chat-input' &&
      chatNodeConfigSchema.parse(node.config).sessionId === inputSessionId,
  );
  const work = starts.map((node) => node.id);
  const visited = new Set<string>();
  const outputSessionIds = new Set<string>();

  while (work.length) {
    const nodeId = work.shift()!;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    const node = nodes.get(nodeId)!;
    if (!shouldContinue(node, message)) continue;
    if (node.type === 'chat-output') {
      outputSessionIds.add(chatNodeConfigSchema.parse(node.config).sessionId);
    }
    work.push(...(outgoing.get(nodeId) ?? []));
  }

  return {
    outputSessionIds: [...outputSessionIds],
    visitedNodeIds: [...visited],
  };
}

function shouldContinue(node: BlueprintNode, message: MessageEnvelope): boolean {
  if (node.type === 'message-type-filter') {
    return messageTypeFilterConfigSchema.parse(node.config).allowedKinds.includes(message.kind);
  }
  if (node.type === 'text-condition') {
    const config = textConditionConfigSchema.parse(node.config);
    const haystack = message.text ?? '';
    return config.caseSensitive
      ? haystack.includes(config.contains)
      : haystack.toLocaleLowerCase().includes(config.contains.toLocaleLowerCase());
  }
  if (node.type === 'discard') return false;
  return true;
}
