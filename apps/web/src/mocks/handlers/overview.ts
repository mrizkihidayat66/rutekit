import { http, scenariosActive } from '../net.ts';
import {
  dashboardSchema,
  logsResponseSchema,
  lowStressBodySchema,
  requestDetailSchema,
  requestsResponseSchema,
  timeWindowSchema,
  usageBreakdownDimensionSchema,
  usageBreakdownResponseSchema,
  usageSeriesSchema,
  usageSummarySchema,
} from '@contracts';

import { db, matches, paginate, sortBy } from '../db.ts';
import { requestsInWindow } from '../fixtures/telemetry.ts';
import { bodyOf, listParams, notFound, ok, paramId, respond, route, searchParams, strParam } from './helpers.ts';

/** Overview section: Dashboard, Usage & Metrics, Console Log. */

function windowOf(params: URLSearchParams) {
  const parsed = timeWindowSchema.safeParse(params.get('window'));
  return parsed.success ? parsed.data : '24h';
}

export const overviewHandlers = [
  http.get(route('dashboard'), () => respond(dashboardSchema, db.dashboard())),

  http.post(route('lowStress'), async ({ request }) => {
    const body = lowStressBodySchema.parse(await bodyOf(request));
    db.updateGeneralSettings({ lowStressMode: body.enabled });
    return ok();
  }),

  http.get(route('usageSummary'), ({ request }) => {
    const window = windowOf(searchParams(request));
    return respond(usageSummarySchema, db.usageSummary(window));
  }),

  http.get(route('usageSeries'), ({ request }) => {
    const window = windowOf(searchParams(request));
    return respond(usageSeriesSchema, { window, points: db.usageSeries(window) });
  }),

  http.get(route('usageBreakdown'), ({ request }) => {
    const params = searchParams(request);
    const window = windowOf(params);
    const dimension = usageBreakdownDimensionSchema.catch('provider').parse(params.get('dimension'));
    return respond(usageBreakdownResponseSchema, {
      window,
      dimension,
      rows: db.usageBreakdown(window, dimension),
    });
  }),

  http.get(route('requests'), ({ request }) => {
    const params = searchParams(request);
    const { cursor, limit, sort, direction } = listParams(request);
    const window = windowOf(params);
    const providerId = strParam(params, 'providerId');
    const model = strParam(params, 'model');
    const apiKeyId = strParam(params, 'apiKeyId');
    const outcome = params.get('outcome') ?? 'all';

    let items = requestsInWindow(db.requests, window);
    if (providerId !== null) items = items.filter((entry) => entry.providerId === providerId);
    if (model !== null) items = items.filter((entry) => entry.model === model);
    if (apiKeyId !== null) items = items.filter((entry) => entry.apiKeyId === apiKeyId);
    if (outcome === 'errors') items = items.filter((entry) => entry.status >= 400);
    if (outcome === 'success') items = items.filter((entry) => entry.status < 400);

    return respond(requestsResponseSchema, paginate(sortBy(items, sort, direction), { cursor, limit }));
  }),

  http.get(route('request'), ({ params }) => {
    const detail = db.requestDetail(paramId(params));
    return detail === undefined ? notFound('request', paramId(params)) : respond(requestDetailSchema, detail);
  }),

  http.get(route('logs'), ({ request }) => {
    const params = searchParams(request);
    const { cursor, limit, sort, direction } = listParams(request);
    const level = strParam(params, 'level');
    const kind = strParam(params, 'kind');
    const requestId = strParam(params, 'requestId');
    const q = params.get('q') ?? '';

    // The tail grows while the operator watches: a head request (no cursor) in
    // the browser appends one fresh line, so a followed log has something new to
    // show. Paginated requests never append, so paging back stays stable.
    if (cursor === null && scenariosActive()) db.appendLiveLog();

    let items = db.logs;
    if (kind !== null) items = items.filter((entry) => entry.kind === kind);
    if (requestId !== null) items = items.filter((entry) => entry.requestId === requestId);
    items = items.filter((entry) => matches([entry.message, entry.requestId, entry.providerId, entry.accountId], q));

    // Counts describe the set the other filters left, before the level tab
    // narrows it: each tab then says how many lines of that level are here, and
    // the tabs still add up to the "All" figure after a search or a kind filter.
    const counts = db.logCounts(items);
    if (level !== null) items = items.filter((entry) => entry.level === level);

    const page = paginate(sortBy(items, sort, direction), { cursor, limit });
    return respond(logsResponseSchema, { ...page, counts });
  }),
];
