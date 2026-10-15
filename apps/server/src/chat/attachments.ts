import type { ChatAttachment, ContentBlock } from '@contracts';

import { AppError } from '@server/errors.ts';

/**
 * What an attachment becomes in the request the model reads (C9, FR-7.7).
 *
 * The console keeps a turn's attachments beside its text — the contract has two
 * fields, and the transcript renders them as chips next to the message — but a
 * model reads one content array. So this is the fold: an image becomes an `image`
 * block, a text file becomes a `text` block labelled with its name.
 *
 * **The label is there for the model, not for the reader.** Without it a dropped
 * log arrives as a wall of text with nothing saying where it came from, and "the
 * file you attached" has no referent. One line naming the file is the smallest
 * thing that makes the attachment a thing the answer can talk about.
 *
 * **The limits are the server's own, and they are the same numbers the console
 * uses.** Not because the console's copy is trusted — it is not, and the sizes
 * below are measured from the bytes that arrived rather than from the `byteSize`
 * the client declared — but because two different ceilings would mean a turn the
 * console accepted and the server refused, which reads as a bug rather than as a
 * policy. Images are capped at what the console scales to, text at what it will
 * take whole; a text file is refused rather than truncated, because a silently
 * shortened log produces a confident answer about the wrong thing.
 *
 * The whole body is already capped by `bodyPolicy` (16 MB), which is what bounds
 * the total: a turn carries only its own attachments, since the transcript is
 * read from the database rather than sent back by the client.
 */

/** Longest edge the console scales an image to; the ceiling it will not exceed after. */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** Text is taken whole or not at all, the same as the console. */
export const MAX_TEXT_BYTES = 256 * 1024;

/**
 * The media types a text attachment may claim.
 *
 * The same expression the console filters on. An empty type is allowed too — a
 * file with no extension arrives that way, and refusing it would reject a `.log`
 * the operator could plainly see.
 */
const TEXT_LIKE = /^text\/|^application\/(json|xml|yaml|x-yaml|javascript|typescript)$/;

/**
 * The turn's content blocks, text first and attachments after.
 *
 * Order is the client's own: the prompt the operator typed, then what they
 * dropped onto it.
 */
export function attachmentBlocks(attachments: readonly ChatAttachment[]): ContentBlock[] {
  return attachments.map(blockOf);
}

function blockOf(attachment: ChatAttachment): ContentBlock {
  return attachment.kind === 'image' ? imageBlock(attachment) : textBlock(attachment);
}

function imageBlock(attachment: ChatAttachment): ContentBlock {
  if (!attachment.mimeType.startsWith('image/')) {
    throw AppError.invalidRequest(`"${attachment.name}" is not an image.`);
  }
  const data = stripDataUrl(attachment.data);
  const bytes = base64Bytes(data);
  if (bytes > MAX_IMAGE_BYTES) {
    throw AppError.invalidRequest(
      `"${attachment.name}" is ${String(bytes)} bytes; the limit is ${String(MAX_IMAGE_BYTES)}.`,
    );
  }
  return { type: 'image', mediaType: attachment.mimeType, data, url: null };
}

function textBlock(attachment: ChatAttachment): ContentBlock {
  if (attachment.mimeType !== '' && !TEXT_LIKE.test(attachment.mimeType)) {
    throw AppError.invalidRequest(
      `"${attachment.name}" is ${attachment.mimeType}; only images and text files can be attached.`,
    );
  }
  // Measured from the text rather than from `byteSize`, which is the client's
  // claim about a file the server never saw.
  const bytes = new TextEncoder().encode(attachment.data).byteLength;
  if (bytes > MAX_TEXT_BYTES) {
    throw AppError.invalidRequest(
      `"${attachment.name}" is ${String(bytes)} bytes; the limit is ${String(MAX_TEXT_BYTES)}.`,
    );
  }
  return { type: 'text', text: `[${attachment.name}]\n${attachment.data}` };
}

/**
 * The payload without a `data:` prefix, if it has one.
 *
 * The console strips the prefix before sending, so what normally arrives is bare
 * base64 — but the contract's own comment says "data URL for images", and a
 * caller that believed it would send the whole thing. Accepting both costs one
 * comparison and means the two readings of the field cannot disagree.
 */
function stripDataUrl(value: string): string {
  if (!value.startsWith('data:')) return value;
  const comma = value.indexOf(',');
  return comma === -1 ? value : value.slice(comma + 1);
}

/** The decoded length of a base64 string, without decoding it. */
function base64Bytes(data: string): number {
  if (data === '') return 0;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}
