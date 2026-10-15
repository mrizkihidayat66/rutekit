import type { MiddlewareHandler } from 'hono';
import { deriveApiKeyState } from '@contracts';

import { toApiKey } from '@server/api-keys/service.ts';
import type { ApiKeyService } from '@server/api-keys/service.ts';
import type { KeyRateLimiter } from '@server/api-keys/limits.ts';
import { AppError } from '@server/errors.ts';
import type { AppEnv } from '@server/types.ts';

/**
 * The data plane's door (FR-6, ADR-0008).
 *
 * `/v1/*` is spoken by an SDK holding an API key, never by the dashboard, so
 * this guard is the whole of its authentication: a `Bearer` secret that hashes
 * to a stored row, a lifecycle state that still permits traffic, and the key's
 * own two ceilings.
 *
 * The state is read through the contract's `deriveApiKeyState` — the same
 * function the console uses to paint the badge — so a key shown as expired is
 * refused as expired, at the same instant, by the same rule.
 *
 * A key that fails any check is refused with the kind that says *why*: a bad or
 * unknown secret is `authentication`, an exhausted budget is `quota_exhausted`,
 * and a ceiling is `rate_limit` with a `retry-after`. Nothing is forwarded
 * upstream on a refused request.
 */

const BEARER = /^Bearer\s+(.+)$/i;

function presentedSecret(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = BEARER.exec(header.trim());
  const secret = match?.[1]?.trim();
  return secret === undefined || secret === '' ? null : secret;
}

export function apiKeyGuard(apiKeys: ApiKeyService, limiter: KeyRateLimiter): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const secret = presentedSecret(c.req.header('authorization'));
    if (secret === null) {
      throw AppError.authentication('Provide an API key as `Authorization: Bearer <key>`.');
    }

    const row = apiKeys.findBySecret(secret);
    if (row === null) throw AppError.authentication('That API key is not recognised.');

    switch (deriveApiKeyState(toApiKey(row), new Date())) {
      case 'revoked':
        throw AppError.authentication('That API key has been revoked.');
      case 'expired':
        throw AppError.authentication('That API key has expired.');
      case 'exhausted':
        throw new AppError('quota_exhausted', 'That API key has reached its budget.');
      case 'active':
        break;
    }

    const decision = limiter.check(
      row.id,
      { tpsLimit: row.tpsLimit, rateLimitPerMinute: row.rateLimitPerMinute },
      Date.now(),
    );
    if (!decision.allowed) throw AppError.rateLimit(decision.retryAfterSeconds);

    c.set('apiKeyId', row.id);
    await next();
  };
}
