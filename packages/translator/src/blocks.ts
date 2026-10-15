import type { ContentBlock, ImageBlock, TextBlock } from '@contracts';

/**
 * Turning loose JSON into pivot blocks.
 *
 * Every surface hands over `unknown` in the places where a dialect is open-ended
 * — a tool's `input_schema`, a tool result's `content`, an image's `source` — so
 * these are the narrowing helpers the ingest functions share. Each returns `null`
 * rather than throwing: a part the pivot cannot express is dropped at the point
 * it is understood to be unrepresentable, instead of surfacing later as a
 * provider complaining about a field it never asked for.
 */

/** A plain object, or `null` for anything else — including arrays. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** `data:<mediaType>;base64,<payload>`, the only data URL the pivot inlines. */
const BASE64_DATA_URL = /^data:([^;,]*);base64,(.*)$/s;

/**
 * An image block from a URL, an OpenAI `{ url }` wrapper, or either dialect's
 * shape around one.
 *
 * A base64 data URL becomes an inline block; anything else — a remote `https:`
 * URL, a data URL that is not base64 — is carried in `url`. The pivot holds the
 * reference rather than fetching it, so the decision stays with the codec.
 */
export function imageBlockFromUrl(value: unknown): ImageBlock | null {
  const url = typeof value === 'string' ? value : asRecord(value)?.url;
  if (typeof url !== 'string') return null;

  const match = BASE64_DATA_URL.exec(url);
  if (match !== null) {
    return { type: 'image', mediaType: match[1] ?? '', data: match[2] ?? '', url: null };
  }
  return { type: 'image', mediaType: '', data: '', url };
}

/** Anthropic's `source`: `{ type: 'base64', media_type, data }` or `{ type: 'url', url }`. */
function imageBlockFromSource(source: unknown): ImageBlock | null {
  const record = asRecord(source);
  if (record === null) return null;

  if (record.type === 'base64' && typeof record.data === 'string') {
    const mediaType = typeof record.media_type === 'string' ? record.media_type : '';
    return { type: 'image', mediaType, data: record.data, url: null };
  }
  if (record.type === 'url') return imageBlockFromUrl(record.url);
  return null;
}

/**
 * An image part in any of the dialects' spellings — `image` with a `source`,
 * `image_url`, or `input_image` — or `null` when the value is not one.
 */
export function imageBlockOf(value: unknown): ImageBlock | null {
  const record = asRecord(value);
  if (record === null) return null;

  if (record.source !== undefined) {
    const fromSource = imageBlockFromSource(record.source);
    if (fromSource !== null) return fromSource;
  }
  if (record.image_url !== undefined) return imageBlockFromUrl(record.image_url);
  return null;
}

/** A text or image part, which is all a tool result may contain. */
export function contentBlockOf(value: unknown): TextBlock | ImageBlock | null {
  const record = asRecord(value);
  if (record === null) return null;
  if (typeof record.text === 'string') return { type: 'text', text: record.text };
  return imageBlockOf(record);
}

/** A tool result's `content`, which is a string, a part list, or a lone part. */
export function toolResultContentOf(content: unknown): Array<TextBlock | ImageBlock> {
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }];

  const parts = Array.isArray(content) ? content : [content];
  const blocks: Array<TextBlock | ImageBlock> = [];
  for (const part of parts) {
    const block = contentBlockOf(part);
    if (block !== null) blocks.push(block);
  }
  return blocks;
}

/**
 * Tool arguments, which the OpenAI surfaces carry as a JSON string.
 *
 * A model that emits malformed JSON is a real occurrence, and this is the
 * client's own transcript being read back rather than a fresh instruction, so
 * the failure is absorbed: `{}` keeps the call's name and id, which is what the
 * provider needs to accept the turn, and inventing a field to hold the raw text
 * would be a shape no provider understands.
 */
export function parseToolArguments(raw: string): Record<string, unknown> {
  if (raw.trim() === '') return {};
  try {
    return asRecord(JSON.parse(raw)) ?? {};
  } catch {
    return {};
  }
}

/** Narrow a block list to the text blocks, for the places only text is valid. */
export function textBlocksOf(blocks: readonly ContentBlock[]): TextBlock[] {
  return blocks.filter((block): block is TextBlock => block.type === 'text');
}
