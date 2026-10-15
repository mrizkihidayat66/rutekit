import type { MiddlewareHandler } from 'hono';

import { AppError } from '@server/errors.ts';
import type { AppEnv } from '@server/types.ts';

/**
 * What a request is allowed to be before anything reads it.
 *
 * A limit is checked from `Content-Length` rather than by buffering the body and
 * measuring it: the point is to refuse the payload before it is materialised,
 * and a body that has already been read into memory has already cost what the
 * limit was meant to save. A chunked request without a declared length is left
 * to the runtime's own cap.
 */

const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Generous by default: a chat turn can carry several base64 images (R6.6). */
export const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;

export interface BodyPolicyOptions {
  readonly maxBytes?: number;
}

function isAcceptableContentType(value: string): boolean {
  const type = value.toLowerCase();
  return type.includes('application/json') || type.startsWith('multipart/form-data');
}

export function bodyPolicy(options: BodyPolicyOptions = {}): MiddlewareHandler<AppEnv> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BODY_BYTES;

  return async (c, next) => {
    if (METHODS_WITH_BODY.has(c.req.method.toUpperCase())) {
      const declared = c.req.header('content-length');
      if (declared !== undefined) {
        const length = Number(declared);
        if (!Number.isInteger(length) || length < 0) {
          throw AppError.invalidRequest('content-length must be a non-negative integer.');
        }
        if (length > maxBytes) {
          throw new AppError('invalid_request', `Request body exceeds ${maxBytes} bytes.`, {
            status: 413,
          });
        }
      }

      // An empty body is legitimate on DELETE and on a POST whose input is all
      // in the path; only a body that is present and mislabelled is refused.
      const contentType = c.req.header('content-type');
      if (contentType !== undefined && contentType !== '' && !isAcceptableContentType(contentType)) {
        throw new AppError('invalid_request', 'Expected an application/json request body.', {
          status: 415,
        });
      }
    }
    await next();
  };
}
