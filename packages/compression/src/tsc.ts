import type { ToolDefinition } from '@contracts';
import type { CanonicalRequest } from '@translator';

import type { CompressionStage, StageOutcome } from './types.ts';

/**
 * TSC — Tool Schema Compression.
 *
 * Tool definitions are the densest part of a request: every call carries the
 * full JSON Schema of every tool, and a schema generated from a validation
 * library arrives with annotations no model reads. This stage strips those
 * annotations — `title`, `examples`, `default`, `$schema`, the `readOnly`/
 * `writeOnly` pair — and trims each description to its first sentence.
 *
 * It is *structural* rather than lossy: an annotation is not a constraint, so
 * the schema still accepts exactly the same inputs. What it loses is the prose a
 * human would read, which is the point.
 */

const ANNOTATION_KEYS = new Set([
  '$schema',
  '$id',
  '$comment',
  'title',
  'examples',
  'default',
  'deprecated',
  'readOnly',
  'writeOnly',
  'contentMediaType',
  'contentEncoding',
  'unevaluatedProperties',
]);

/** Deep enough for any schema a tool generator produces; a guard, not a limit. */
const MAX_DEPTH = 12;

const DESCRIPTION_LIMIT = 160;

function compactDescription(value: string): string {
  const firstLine = (value.split('\n')[0] ?? '').trim();
  const sentence = /^(.+?[.!?])(\s|$)/.exec(firstLine)?.[1] ?? firstLine;
  if (sentence.length <= DESCRIPTION_LIMIT) return sentence;
  return `${sentence.slice(0, DESCRIPTION_LIMIT - 3)}...`;
}

function compactValue(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map((item) => compactValue(item, depth + 1));
  if (typeof value !== 'object' || value === null) return value;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (ANNOTATION_KEYS.has(key)) continue;
    out[key] = key === 'description' && typeof child === 'string' ? compactDescription(child) : compactValue(child, depth + 1);
  }
  return out;
}

function compactParameters(parameters: Record<string, unknown>): Record<string, unknown> {
  const compacted = compactValue(parameters, 0);
  if (typeof compacted !== 'object' || compacted === null || Array.isArray(compacted)) {
    return parameters;
  }
  return compacted as Record<string, unknown>;
}

function compactTool(tool: ToolDefinition): ToolDefinition | null {
  const parameters = compactParameters(tool.parameters);
  const description = tool.description === null ? null : compactDescription(tool.description);
  if (description === tool.description && JSON.stringify(parameters) === JSON.stringify(tool.parameters)) {
    return null;
  }
  return { name: tool.name, description, parameters };
}

export const tscStage: CompressionStage = {
  id: 'tsc',
  nature: 'structural',

  apply(request: CanonicalRequest): StageOutcome | null {
    if (request.tools.length === 0) return null;

    let changed = false;
    const tools = request.tools.map((tool) => {
      const compacted = compactTool(tool);
      if (compacted === null) return tool;
      changed = true;
      return compacted;
    });

    return changed ? { request: { ...request, tools } } : null;
  },
};
