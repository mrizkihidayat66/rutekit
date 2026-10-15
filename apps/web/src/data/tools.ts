import type {
  BenchmarkInput,
  ChatSessionInput,
  ChatSessionUpdate,
  ChatSessionsQuery,
  DotTrickBody,
  StudioAssetUpdate,
  StudioAssetsQuery,
  StudioGenerateBody,
  StudioGenerationsQuery,
  VccCardUpdate,
  VccCardsQuery,
  VccGenerateBody,
  VerificationInput,
  VerificationsQuery,
} from '@contracts';
import {
  assetSchema,
  benchmarkRunSchema,
  benchmarksResponseSchema,
  chatSessionSchema,
  chatSessionsResponseSchema,
  consolePath,
  consolePaths,
  dotTrickResultSchema,
  generationJobSchema,
  okSchema,
  studioAssetsResponseSchema,
  studioGenerateResultSchema,
  studioGenerationsResponseSchema,
  verificationResultSchema,
  verificationsResponseSchema,
  vccBinsResponseSchema,
  vccCardSchema,
  vccCardsResponseSchema,
  vccGenerateResultSchema,
} from '@contracts';

import { apiDelete, apiGet, apiPatch, apiPost, withQuery } from './client.ts';

/**
 * The Tools section's requests, as plain functions.
 *
 * Five screens share this module because they are five faces of one idea: they
 * all *send something to a model and read what comes back*, and they differ only
 * in what they do with the answer. Chat keeps the reply as a conversation, Studio
 * keeps it as a file, Benchmark keeps it as a row of numbers, Verification keeps
 * it as evidence about the endpoint, and the last group of tools never sends
 * anything at all — the dot trick and the card generator are local arithmetic
 * that the server performs so the client does not have to ship a Luhn routine.
 *
 * The one request that is *not* here is the chat turn. Every function in this
 * module parses a JSON body against a contract, and a streamed reply has no body
 * to parse: it is read frame by frame as it is written. That request lives in
 * the page's own transport, which is also what lets the AI SDK own the SSE
 * parsing instead of a hand-written reader.
 */

/* ---- Chat ---- */

export function fetchChatSessions(query: ChatSessionsQuery, signal?: AbortSignal) {
  return apiGet(
    withQuery(consolePath(consolePaths.chatSessions), {
      q: query.q,
      sort: query.sort,
      direction: query.direction,
      limit: query.limit,
      cursor: query.cursor,
    }),
    chatSessionsResponseSchema,
    signal,
  );
}

export function fetchChatSession(id: string, signal?: AbortSignal) {
  return apiGet(consolePath(consolePaths.chatSession, { id }), chatSessionSchema, signal);
}

export function createChatSession(input: ChatSessionInput, signal?: AbortSignal) {
  return apiPost(consolePath(consolePaths.chatSessions), chatSessionSchema, input, signal);
}

export function updateChatSession(id: string, patch: ChatSessionUpdate, signal?: AbortSignal) {
  return apiPatch(consolePath(consolePaths.chatSession, { id }), chatSessionSchema, patch, signal);
}

export function deleteChatSession(id: string, signal?: AbortSignal) {
  return apiDelete(consolePath(consolePaths.chatSession, { id }), okSchema, signal);
}

/* ---- Studio ---- */

export function fetchStudioAssets(query: StudioAssetsQuery, signal?: AbortSignal) {
  return apiGet(
    withQuery(consolePath(consolePaths.studioAssets), {
      kind: query.kind,
      favorite: query.favorite ? 'true' : null,
      q: query.q,
      sort: query.sort,
      direction: query.direction,
      limit: query.limit,
      cursor: query.cursor,
    }),
    studioAssetsResponseSchema,
    signal,
  );
}

export function fetchStudioAsset(id: string, signal?: AbortSignal) {
  return apiGet(consolePath(consolePaths.studioAsset, { id }), assetSchema, signal);
}

export function updateStudioAsset(id: string, patch: StudioAssetUpdate, signal?: AbortSignal) {
  return apiPatch(consolePath(consolePaths.studioAsset, { id }), assetSchema, patch, signal);
}

export function deleteStudioAsset(id: string, signal?: AbortSignal) {
  return apiDelete(consolePath(consolePaths.studioAsset, { id }), okSchema, signal);
}

/**
 * The generation queue.
 *
 * Paged like the other lists, but polled while anything in it is still moving —
 * a generation walks from `queued` to `executed` on its own and the gallery is
 * how the operator watches it do so.
 */
export function fetchStudioGenerations(query: StudioGenerationsQuery, signal?: AbortSignal) {
  return apiGet(
    withQuery(consolePath(consolePaths.studioGenerations), {
      kind: query.kind,
      status: query.status,
      sort: query.sort,
      direction: query.direction,
      limit: query.limit,
      cursor: query.cursor,
    }),
    studioGenerationsResponseSchema,
    signal,
  );
}

export function fetchStudioGeneration(id: string, signal?: AbortSignal) {
  return apiGet(consolePath(consolePaths.studioGeneration, { id }), generationJobSchema, signal);
}

/** Fan a prompt out into `count` generation jobs. */
export function createStudioGeneration(body: StudioGenerateBody, signal?: AbortSignal) {
  return apiPost(consolePath(consolePaths.studioGenerations), studioGenerateResultSchema, body, signal);
}

/* ---- Benchmark ---- */

export function fetchBenchmarks(query: ChatSessionsQuery, signal?: AbortSignal) {
  return apiGet(
    withQuery(consolePath(consolePaths.benchmarks), {
      q: query.q,
      sort: query.sort,
      direction: query.direction,
      limit: query.limit,
      cursor: query.cursor,
    }),
    benchmarksResponseSchema,
    signal,
  );
}

export function fetchBenchmark(id: string, signal?: AbortSignal) {
  return apiGet(consolePath(consolePaths.benchmark, { id }), benchmarkRunSchema, signal);
}

/** Queue a run. It comes back `queued` with no results; the cells fill in after. */
export function createBenchmark(input: BenchmarkInput, signal?: AbortSignal) {
  return apiPost(consolePath(consolePaths.benchmarks), benchmarkRunSchema, input, signal);
}

/* ---- Model Verification ---- */

export function fetchVerifications(query: VerificationsQuery, signal?: AbortSignal) {
  return apiGet(
    withQuery(consolePath(consolePaths.verifications), {
      q: query.q,
      sort: query.sort,
      direction: query.direction,
      limit: query.limit,
      cursor: query.cursor,
    }),
    verificationsResponseSchema,
    signal,
  );
}

export function fetchVerification(id: string, signal?: AbortSignal) {
  return apiGet(consolePath(consolePaths.verification, { id }), verificationResultSchema, signal);
}

/** Run the probes. The verdict is a band, and provisional until the run finishes. */
export function createVerification(input: VerificationInput, signal?: AbortSignal) {
  return apiPost(consolePath(consolePaths.verifications), verificationResultSchema, input, signal);
}

/* ---- Dot trick ---- */

/** Expand an address into its dot/plus variants. Pure arithmetic, no state. */
export function runDotTrick(body: DotTrickBody, signal?: AbortSignal) {
  return apiPost(consolePath(consolePaths.dotTrick), dotTrickResultSchema, body, signal);
}

/* ---- VCC pool ---- */

export function fetchVccCards(query: VccCardsQuery, signal?: AbortSignal) {
  return apiGet(
    withQuery(consolePath(consolePaths.vccCards), {
      brand: query.brand,
      status: query.status,
      q: query.q,
      sort: query.sort,
      direction: query.direction,
      limit: query.limit,
      cursor: query.cursor,
    }),
    vccCardsResponseSchema,
    signal,
  );
}

export function fetchVccCard(id: string, signal?: AbortSignal) {
  return apiGet(consolePath(consolePaths.vccCard, { id }), vccCardSchema, signal);
}

/**
 * The issuer ranges the generator can be pointed at.
 *
 * Not paged and not filtered: it is a short curated list and the picker wants
 * every row at once so it can offer them as a choice rather than a search box.
 */
export function fetchVccBins(signal?: AbortSignal) {
  return apiGet(consolePath(consolePaths.vccBins), vccBinsResponseSchema, signal);
}

/** Mint a batch from a BIN. The PAN is generated and masked server-side. */
export function generateVccCards(body: VccGenerateBody, signal?: AbortSignal) {
  return apiPost(consolePath(consolePaths.vccGenerate), vccGenerateResultSchema, body, signal);
}

export function updateVccCard(id: string, patch: VccCardUpdate, signal?: AbortSignal) {
  return apiPatch(consolePath(consolePaths.vccCard, { id }), vccCardSchema, patch, signal);
}
