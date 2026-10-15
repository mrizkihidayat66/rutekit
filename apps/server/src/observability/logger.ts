import { Writable } from 'node:stream';
import pino from 'pino';
import type { Logger } from 'pino';

import type { LogLevel } from '@server/runtime/config.ts';
import { entryFromLogLine, type LogRing } from './log-ring.ts';

/**
 * The server's one logger.
 *
 * Deliberately plain stdout JSON with no transport: a transport runs in a worker
 * thread, and the two things that must always work — the line written while
 * draining and the line written for a boot failure — are exactly the two that a
 * worker-thread transport can lose. Collection is the deployment's job.
 *
 * The redaction list is the load-bearing part. Provider keys, session cookies,
 * account tokens and the encryption key all pass through request handlers, and
 * a logger that quietly writes them to disk turns a debugging aid into a
 * credential store (SEC-1, R5.10).
 */

/** Field names censored wherever they appear, at the top level or one level in. */
const SECRET_FIELDS = [
  'password',
  'newPassword',
  'currentPassword',
  'apiKey',
  'api_key',
  'keyHint',
  'token',
  'accessToken',
  'refreshToken',
  'secret',
  'authorization',
  'cookie',
  'encryptionKey',
  'authSecret',
  'capsolverKey',
];

const REDACT_PATHS = [
  ...SECRET_FIELDS,
  ...SECRET_FIELDS.map((field) => `*.${field}`),
  'headers.authorization',
  'headers.cookie',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
];

export function createLogger(level: LogLevel): Logger {
  return pino(
    {
      level,
      // pid and hostname are noise in a single-container deployment, and they make
      // every line longer than the message it carries.
      base: null,
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    },
    // stdout is still the destination — the console log is a *copy*, not a
    // replacement, because the line written while draining is the one an operator
    // reads out of `docker logs`.
  );
}

/**
 * A logger that also feeds the console's log ring (FR-12.1).
 *
 * pino writes to the stream it is handed, so the ring is fed by a passthrough
 * that parses each line and forwards the bytes unchanged. The alternative —
 * logging twice, once for stdout and once for the ring — would let the two
 * disagree, and a console log that does not match what the process actually said
 * is worse than no console log.
 *
 * Parsing on the way past is cheap and happens on pino's own write path rather
 * than in a worker thread, which is the same reason there is no transport here:
 * the lines that must always get out are exactly the ones a worker can lose.
 */
export function createLoggerWithRing(level: LogLevel, ring: LogRing): Logger {
  const tee = new Writable({
    write(chunk: Buffer, _encoding, callback): void {
      const line = chunk.toString();
      // A chunk is one line in pino's default framing, but a split write is
      // possible; each fragment that is not a whole JSON object is simply not an
      // entry, and the next complete line is.
      for (const part of line.split('\n')) {
        if (part.trim() === '') continue;
        const entry = entryFromLogLine(part);
        if (entry !== null) ring.append(entry);
      }
      process.stdout.write(chunk);
      callback();
    },
  });

  return pino(
    {
      level,
      base: null,
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    },
    tee,
  );
}

/** A logger that discards everything, for tests that do not assert on output. */
export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}
