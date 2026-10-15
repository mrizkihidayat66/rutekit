import type { ChatAttachment } from '@contracts';

/**
 * Turning a file the operator dropped, pasted or picked into an attachment.
 *
 * The reason this is not a one-liner is size. A screenshot from a modern display
 * is several thousand pixels across and a few megabytes, and a model does not
 * need either: it needs enough pixels to read the content and no more. Sending
 * the original would cost tokens on every turn that follows and would hit the
 * provider's own image limit on a large enough monitor, so images are scaled
 * down here, once, at the point they enter the console.
 *
 * Text is the opposite problem. A pasted log can be a megabyte, and unlike an
 * image there is no lossy way to make it smaller, so it is refused rather than
 * truncated — a silently shortened log is worse than a rejected one, because
 * the answer will be confidently about the wrong thing.
 */

/** Longest edge an image is scaled to. Enough to read a screenshot, not a poster. */
const MAX_IMAGE_EDGE = 1568;

/** A scaled image above this is refused rather than sent. */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** Text files are taken whole or not at all. */
const MAX_TEXT_BYTES = 256 * 1024;

const TEXT_LIKE = /^text\/|^application\/(json|xml|yaml|x-yaml|javascript|typescript)$/;

export interface AttachmentRejection {
  readonly name: string;
  readonly reason: string;
}

let counter = 0;
function nextId(): string {
  counter += 1;
  return `att_${Date.now().toString(36)}_${String(counter)}`;
}

function stripDataUrl(value: string): string {
  const comma = value.indexOf(',');
  return comma === -1 ? value : value.slice(comma + 1);
}

async function scaleImage(file: File): Promise<{ data: string; mimeType: string; width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  const longest = Math.max(bitmap.width, bitmap.height);
  const ratio = longest > MAX_IMAGE_EDGE ? MAX_IMAGE_EDGE / longest : 1;
  const width = Math.max(1, Math.round(bitmap.width * ratio));
  const height = Math.max(1, Math.round(bitmap.height * ratio));

  if (ratio === 1 && file.size <= MAX_IMAGE_BYTES) {
    const buffer = await file.arrayBuffer();
    const data = stripDataUrl(`data:;base64,${toBase64(buffer)}`);
    bitmap.close();
    return { data, mimeType: file.type, width, height };
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('This browser cannot scale images.');
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  // PNG keeps text crisp, which is most of what gets pasted into a chat; a photo
  // is the case where it costs more than it is worth.
  const mimeType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, mimeType, mimeType === 'image/jpeg' ? 0.85 : undefined);
  });
  if (blob === null) throw new Error('This browser could not encode the image.');
  if (blob.size > MAX_IMAGE_BYTES) throw new Error('That image is still too large after scaling.');

  return { data: stripDataUrl(await blobToDataUrl(blob)), mimeType, width, height };
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(typeof reader.result === 'string' ? reader.result : '');
    };
    reader.onerror = () => {
      reject(new Error('The file could not be read.'));
    };
    reader.readAsDataURL(blob);
  });
}

/** Read one file, or say why it cannot be attached. */
export async function readAttachment(
  file: File,
): Promise<{ attachment: ChatAttachment } | { rejection: AttachmentRejection }> {
  try {
    if (file.type.startsWith('image/')) {
      const scaled = await scaleImage(file);
      return {
        attachment: {
          id: nextId(),
          kind: 'image',
          name: file.name === '' ? 'pasted-image.png' : file.name,
          mimeType: scaled.mimeType,
          byteSize: Math.round((scaled.data.length * 3) / 4),
          data: scaled.data,
          width: scaled.width,
          height: scaled.height,
        },
      };
    }

    if (!TEXT_LIKE.test(file.type)) {
      return { rejection: { name: file.name, reason: 'Only images and text files can be attached.' } };
    }
    if (file.size > MAX_TEXT_BYTES) {
      return { rejection: { name: file.name, reason: 'That file is over 256 KB.' } };
    }

    const text = await file.text();
    return {
      attachment: {
        id: nextId(),
        kind: 'text',
        name: file.name === '' ? 'pasted-text.txt' : file.name,
        mimeType: file.type === '' ? 'text/plain' : file.type,
        byteSize: file.size,
        data: text,
        width: null,
        height: null,
      },
    };
  } catch (error) {
    return {
      rejection: { name: file.name, reason: error instanceof Error ? error.message : 'That file could not be read.' },
    };
  }
}

export interface AttachmentBatch {
  readonly attachments: readonly ChatAttachment[];
  readonly rejections: readonly AttachmentRejection[];
}

/** Read a whole drop or paste, keeping the ones that worked and explaining the rest. */
export async function readAttachments(files: readonly File[]): Promise<AttachmentBatch> {
  const results = await Promise.all(files.map(readAttachment));
  const attachments: ChatAttachment[] = [];
  const rejections: AttachmentRejection[] = [];
  for (const result of results) {
    if ('attachment' in result) attachments.push(result.attachment);
    else rejections.push(result.rejection);
  }
  return { attachments, rejections };
}

/** Files carried by a paste event, which includes a screenshot with no name. */
export function filesFromClipboard(data: DataTransfer): File[] {
  return Array.from(data.files).filter((file) => file.size > 0 || file.type.startsWith('image/'));
}
