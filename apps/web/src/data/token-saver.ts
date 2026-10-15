import type { TimeWindow, TokenSaverConfigUpdate } from '@contracts';
import {
  consolePath,
  consolePaths,
  tokenSaverConfigSchema,
  tokenSaverSavingsSchema,
} from '@contracts';

import { apiGet, apiPatch, withQuery } from './client.ts';

/**
 * The compression pipeline's two requests.
 *
 * The settings are a single record — the pipeline is one thing, so there is no
 * id and no list. The savings are a separate read because they move on their own
 * schedule: the settings change when the operator changes them, the figures
 * change with every request the instance proxies.
 */

export function fetchTokenSaverConfig(signal?: AbortSignal) {
  return apiGet(consolePath(consolePaths.tokenSaver), tokenSaverConfigSchema, signal);
}

export function updateTokenSaverConfig(patch: TokenSaverConfigUpdate, signal?: AbortSignal) {
  return apiPatch(consolePath(consolePaths.tokenSaver), tokenSaverConfigSchema, patch, signal);
}

export function fetchTokenSaverSavings(window: TimeWindow, signal?: AbortSignal) {
  const path = withQuery(consolePath(consolePaths.tokenSaverSavings), { window });
  return apiGet(path, tokenSaverSavingsSchema, signal);
}
