import type { BenchmarkRun, BenchmarkSummary, BenchmarkVariant } from '@contracts';
import {
  benchmarkInputSchema,
  benchmarkRunSchema,
  benchmarksResponseSchema,
} from '@contracts';

import { isoAt } from '../clock.ts';
import { db, matches, paginate, sortBy } from '../db.ts';
import { http } from '../net.ts';
import { bodyOf, listParams, notFound, paramId, respond, route, searchParams, uid } from './helpers.ts';

/**
 * The Benchmark page, mocked (FR-9.x).
 *
 * Its own domain rather than part of `tools`, for the same reason `chat` and
 * `studio` are: the Tools section's pages have separate backends landing in
 * separate groups, and a domain is what goes live at once. Benchmark's landed in
 * C11 while Model Verification is still to come (C12).
 *
 * The list answers with **summaries** — a run without its cells, plus a count —
 * because the cells are the whole matrix flattened and the list page reads only
 * the count. That mirrors the real route exactly, so the page does not change
 * when this handler is dropped.
 */

/** One run without its cells, as the list route answers. */
function summarizeRun(run: BenchmarkRun): BenchmarkSummary {
  const { results, ...rest } = run;
  return { ...rest, resultCount: results.length };
}

export const benchmarkHandlers = [
  http.get(route('benchmarks'), ({ request }) => {
    const params = searchParams(request);
    const { cursor, limit, sort, direction } = listParams(request);
    const q = params.get('q') ?? '';
    const items = db.benchmarks
      .filter((entry) => matches([entry.name, entry.id], q))
      .map(summarizeRun);
    return respond(benchmarksResponseSchema, paginate(sortBy(items, sort, direction), { cursor, limit }));
  }),

  http.post(route('benchmarks'), async ({ request }) => {
    const input = benchmarkInputSchema.parse(await bodyOf(request));
    const variants: BenchmarkVariant[] = input.variants.map((variant) => ({
      id: uid('var'),
      label: variant.label,
      prompt: variant.prompt,
      variables: variant.variables,
    }));
    const run: BenchmarkRun = {
      id: uid('bench'),
      name: input.name,
      status: 'queued',
      template: input.template,
      variants,
      targets: input.targets,
      results: [],
      expectedResultCount: variants.length * input.targets.length,
      systemPrompt: input.systemPrompt,
      rubric: input.rubric,
      error: null,
      createdAt: isoAt(0),
      startedAt: null,
      finishedAt: null,
    };
    db.benchmarks.unshift(run);
    return respond(benchmarkRunSchema, run);
  }),

  http.get(route('benchmark'), ({ params }) => {
    const run = db.benchmark(paramId(params));
    return run === undefined ? notFound('benchmark', paramId(params)) : respond(benchmarkRunSchema, run);
  }),
];
