import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ChatSessionsQuery, Ok } from '@contracts';
import {
  chatSessionsQuerySchema,
  chatSessionInputSchema,
  chatSessionUpdateSchema,
  chatTurnRequestSchema,
  consolePaths,
} from '@contracts';
import { createIdFactory } from '@shared';

import { AppError } from '@server/errors.ts';
import { jsonBody } from '@server/ingress/validate.ts';
import { createChatService } from '@server/chat/sessions.ts';
import { createChatTurns } from '@server/chat/turn.ts';
import { createFilterRuleService } from '@server/tools/filter-service.ts';
import type { FilterRuleLike } from '@server/tools/filters.ts';
import type { AppDeps, AppEnv } from '@server/types.ts';

/**
 * The Chat console (C9, FR-7.7–7.10).
 *
 * Six routes over one conversation, and one of them is not like the others:
 * `POST …/messages` answers with a stream rather than a document, because the
 * page paints the first token before the last one exists. That route is also the
 * only one that reaches a provider, and it does so through the same call the
 * `/v1` dispatcher uses — the console is a second front door, not a second
 * implementation.
 *
 * The router is mounted under `/console/api` and the session guard runs before
 * it, so an operator's cookie is the whole of the authentication here: there is
 * no API key on this plane, and a chat turn spends no key's budget. What it does
 * spend is the pool's capacity, through the same lease a `/v1` turn takes — so a
 * console chat and a client's request compete for an account the way two clients
 * would, which is the honest reading of "one instance".
 */
export function chatRoutes(deps: AppDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const chat = createChatService({ sessions: deps.chatSessions });
  const turns = createChatTurns({
    chat,
    catalog: deps.catalog,
    // The same recorder `/v1` writes to, so a console turn appears in the request
    // log, in the usage charts, and in the Token Saver's savings.
    telemetry: deps.telemetry,
    call: {
      pool: deps.pool,
      tokenSaver: deps.tokenSaver,
      filters: () => activeFilters(deps),
      fetch: deps.fetch,
      config: deps.config,
      logger: deps.logger,
      now: () => Math.floor(Date.now() / 1000),
      ids: createIdFactory((bytes) => crypto.getRandomValues(new Uint8Array(bytes))),
      persistCredential: (accountId, credential) => {
        const secrets = deps.secrets;
        if (secrets === null) return;
        deps.accounts.setCredential(accountId, secrets.encrypt(credential), new Date().toISOString());
      },
    },
  });

  router.get(consolePaths.chatSessions, (c) => c.json(chat.list(queryOf(c))));

  router.post(consolePaths.chatSessions, jsonBody(chatSessionInputSchema), (c) =>
    c.json(chat.create(c.req.valid('json')), 201),
  );

  router.get(consolePaths.chatSession, (c) => c.json(chat.get(c.req.param('id'))));

  /**
   * The turn, and its streamed answer.
   *
   * The `Response` is returned rather than written through `c.json`: its body is
   * the provider's frames as they arrive, and buffering it to build a document
   * would defeat the entire point of the route.
   */
  router.post(consolePaths.chatMessages, jsonBody(chatTurnRequestSchema), async (c) => {
    const requestId = c.get('requestId');
    return turns.run(
      c.req.param('id'),
      c.req.valid('json'),
      typeof requestId === 'string' && requestId !== '' ? requestId : null,
    );
  });

  /**
   * The conversation as a file (FR-7.7).
   *
   * `attachment` rather than `inline`: this is a download, and the operator asked
   * for a file. The filename is built from the title and sanitised to letters,
   * digits and dashes, so a title cannot name a path or break the header.
   */
  router.get(consolePaths.chatExport, (c) => {
    const file = chat.exportMarkdown(c.req.param('id'));
    return c.body(file.body, 200, {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename="${file.filename}"`,
    });
  });

  router.patch(consolePaths.chatSession, jsonBody(chatSessionUpdateSchema), (c) =>
    c.json(chat.update(c.req.param('id'), c.req.valid('json'))),
  );

  router.delete(consolePaths.chatSession, (c) => {
    chat.remove(c.req.param('id'));
    return c.json({ ok: true } satisfies Ok);
  });

  return router;
}

/** The sidebar's query, read off the URL. */
function queryOf(c: Context<AppEnv>): ChatSessionsQuery {
  const parsed = chatSessionsQuerySchema.safeParse({
    q: c.req.query('q') ?? '',
    sort: c.req.query('sort') ?? null,
    direction: c.req.query('direction') ?? undefined,
    limit: c.req.query('limit') ?? undefined,
    cursor: c.req.query('cursor') ?? null,
  });
  if (!parsed.success) throw AppError.invalidRequest('The session query was not valid.');
  return parsed.data;
}

/**
 * The content filter rules, as the pipeline reads them (FR-11.3).
 *
 * Read per turn rather than captured at boot, for the reason the data plane gives:
 * a rule an operator saves on the console is in force on the next request. A chat
 * turn passes through the same pipeline and the same rules — the console is a
 * client of this instance like any other, and an operator who wrote a rule to keep
 * a secret out of a provider's logs means it for their own typing too.
 */
function activeFilters(deps: AppDeps): readonly FilterRuleLike[] {
  return createFilterRuleService({ rules: deps.filterRules }).active();
}
