import type { Alias, Combo, FilterRule, ModelMappingRule } from '@contracts';

import { daysAgo, hoursAgo } from '../clock.ts';

/**
 * Aliases, combos, mappings and filters are hand-authored because they are
 * *configuration*, not population: their value in a fixture is that each one
 * demonstrates a distinct rule shape (exact vs regex, sequential vs weighted,
 * block vs redact) rather than that there are many of them.
 */
export function buildAliases(): Alias[] {
  return [
    { id: 'al_fast', alias: 'fast', target: 'gpt-4o-mini', providerId: null, enabled: true, description: 'Cheapest GPT that still calls tools.', createdAt: daysAgo(180), updatedAt: daysAgo(12) },
    { id: 'al_smart', alias: 'smart', target: 'gpt-4.1', providerId: null, enabled: true, description: 'Default for anything that needs to be right.', createdAt: daysAgo(180), updatedAt: daysAgo(9) },
    { id: 'al_reason', alias: 'reason', target: 'o3', providerId: null, enabled: true, description: 'Reasoning tier; slow and priced accordingly.', createdAt: daysAgo(140), updatedAt: daysAgo(30) },
    { id: 'al_vision', alias: 'vision', target: 'gpt-4o', providerId: null, enabled: true, description: 'Image-in, text-out.', createdAt: daysAgo(120), updatedAt: daysAgo(20) },
    { id: 'al_embed', alias: 'embed', target: 'text-embedding-3-large', providerId: null, enabled: true, description: 'Pinned to one model so the index stays comparable.', createdAt: daysAgo(200), updatedAt: daysAgo(200) },
    { id: 'al_local', alias: 'local', target: 'llama3.1:8b', providerId: 'ollama-local', enabled: true, description: 'Runs on the box; no egress, no cost.', createdAt: daysAgo(60), updatedAt: daysAgo(4) },
    { id: 'al_anthropic', alias: 'long-context', target: 'claude-sonnet-4-5', providerId: 'anthropic', enabled: true, description: 'For documents that do not fit elsewhere.', createdAt: daysAgo(75), updatedAt: daysAgo(6) },
    { id: 'al_legacy_davinci', alias: 'davinci', target: 'gpt-3.5-turbo', providerId: null, enabled: false, description: 'Kept so old callers fail loudly rather than silently.', createdAt: daysAgo(320), updatedAt: daysAgo(45) },
    { id: 'al_search', alias: 'web-search', target: 'sonar-pro', providerId: 'perplexity', enabled: true, description: 'Answer with citations.', createdAt: daysAgo(52), updatedAt: daysAgo(8) },
    { id: 'al_byok', alias: 'internal', target: 'internal-gpt-4o', providerId: 'byok-openai', enabled: false, description: 'Points at the office gateway; off while it is migrated.', createdAt: daysAgo(30), updatedAt: daysAgo(2) },
  ];
}

export function buildCombos(): Combo[] {
  return [
    {
      id: 'cb_daily_driver',
      name: 'daily-driver',
      displayName: 'Daily driver',
      description: 'Try the cheap model first and only escalate when it fails.',
      strategy: 'sequential',
      fallbackOnError: true,
      enabled: true,
      createdAt: daysAgo(150),
      updatedAt: daysAgo(5),
      entries: [
        { id: 'cbe_dd_1', model: 'gpt-4o-mini', providerId: 'openai', weight: 1, enabled: true },
        { id: 'cbe_dd_2', model: 'llama-3.3-70b-versatile', providerId: 'groq', weight: 1, enabled: true },
        { id: 'cbe_dd_3', model: 'gpt-4.1', providerId: 'openai', weight: 1, enabled: true },
      ],
    },
    {
      id: 'cb_haiku_fleet',
      name: 'cheap-fleet',
      displayName: 'Cheap fleet',
      description: 'Spread load across the free tiers before any paid call.',
      strategy: 'round_robin',
      fallbackOnError: true,
      enabled: true,
      createdAt: daysAgo(96),
      updatedAt: daysAgo(3),
      entries: [
        { id: 'cbe_cf_1', model: 'gemini-2.0-flash', providerId: 'google-ai-studio', weight: 2, enabled: true },
        { id: 'cbe_cf_2', model: 'mistral-small-latest', providerId: 'mistral', weight: 2, enabled: true },
        { id: 'cbe_cf_3', model: 'llama-3.1-8b-instant', providerId: 'groq', weight: 1, enabled: true },
        { id: 'cbe_cf_4', model: 'qwen2.5-72b-instruct', providerId: 'alibaba-qwen', weight: 1, enabled: false },
      ],
    },
    {
      id: 'cb_long_context',
      name: 'long-context',
      displayName: 'Long context',
      description: 'Only models that will take a whole codebase.',
      strategy: 'sequential',
      fallbackOnError: false,
      enabled: true,
      createdAt: daysAgo(70),
      updatedAt: daysAgo(11),
      entries: [
        { id: 'cbe_lc_1', model: 'gemini-2.5-pro', providerId: 'google-ai-studio', weight: 1, enabled: true },
        { id: 'cbe_lc_2', model: 'claude-sonnet-4-5', providerId: 'anthropic', weight: 1, enabled: true },
      ],
    },
    {
      id: 'cb_reasoning',
      name: 'reasoning',
      displayName: 'Reasoning tier',
      description: 'Weighted toward the model that scored best on the last benchmark.',
      strategy: 'round_robin',
      fallbackOnError: true,
      enabled: true,
      createdAt: daysAgo(44),
      updatedAt: hoursAgo(20),
      entries: [
        { id: 'cbe_rs_1', model: 'o3', providerId: 'openai', weight: 3, enabled: true },
        { id: 'cbe_rs_2', model: 'deepseek-reasoner', providerId: 'deepseek', weight: 2, enabled: true },
        { id: 'cbe_rs_3', model: 'qwq-32b', providerId: 'alibaba-qwen', weight: 1, enabled: true },
      ],
    },
    {
      id: 'cb_offline',
      name: 'offline-only',
      displayName: 'Offline only',
      description: 'Disabled while the local box is being rebuilt.',
      strategy: 'sequential',
      fallbackOnError: false,
      enabled: false,
      createdAt: daysAgo(21),
      updatedAt: daysAgo(1),
      entries: [
        { id: 'cbe_of_1', model: 'llama3.1:8b', providerId: 'ollama-local', weight: 1, enabled: true },
        { id: 'cbe_of_2', model: 'qwen2.5-7b-instruct', providerId: 'lm-studio', weight: 1, enabled: true },
      ],
    },
  ];
}

export function buildMappings(): ModelMappingRule[] {
  return [
    { id: 'map_1', match: 'exact', pattern: 'gpt-4-turbo', replacement: 'gpt-4.1', priority: 0, enabled: true, description: 'Retired alias forwarded to its successor.', createdAt: daysAgo(200), updatedAt: daysAgo(40) },
    { id: 'map_2', match: 'exact', pattern: 'gpt-4', replacement: 'gpt-4.1', priority: 1, enabled: true, description: 'Same, for the unversioned name.', createdAt: daysAgo(200), updatedAt: daysAgo(40) },
    { id: 'map_3', match: 'contains', pattern: 'claude-3-5-sonnet', replacement: 'claude-sonnet-4-5', priority: 10, enabled: true, description: 'Pin old Sonnet callers to the current one.', createdAt: daysAgo(88), updatedAt: daysAgo(14) },
    { id: 'map_4', match: 'regex', pattern: '^gpt-4o-(\\d{4}-\\d{2}-\\d{2})$', replacement: 'gpt-4o', priority: 20, enabled: true, description: 'Strip dated snapshots back to the floating tag.', createdAt: daysAgo(130), updatedAt: daysAgo(60) },
    { id: 'map_5', match: 'contains', pattern: 'llama-3.1-405b', replacement: 'llama-3.3-70b-versatile', priority: 30, enabled: true, description: 'Downgrade a model we no longer host.', createdAt: daysAgo(64), updatedAt: daysAgo(64) },
    { id: 'map_6', match: 'exact', pattern: 'text-davinci-003', replacement: 'gpt-3.5-turbo', priority: 40, enabled: true, description: 'Completions-era callers keep working.', createdAt: daysAgo(240), updatedAt: daysAgo(240) },
    { id: 'map_7', match: 'regex', pattern: '-preview$', replacement: '', priority: 50, enabled: true, description: 'Drop the `-preview` suffix before routing.', createdAt: daysAgo(35), updatedAt: daysAgo(35) },
    { id: 'map_8', match: 'exact', pattern: 'internal-fast', replacement: 'gpt-4o-mini', priority: 60, enabled: false, description: 'Turned off; the BYOK gateway owns this name now.', createdAt: daysAgo(19), updatedAt: daysAgo(2) },
  ];
}

export function buildFilterRules(): FilterRule[] {
  return [
    { id: 'flt_1', name: 'Block API keys in prompts', kind: 'regex', pattern: '\\b(sk|rk)-[A-Za-z0-9]{16,}\\b', action: 'block', phase: 1, enabled: true, createdAt: daysAgo(150), updatedAt: daysAgo(30) },
    { id: 'flt_2', name: 'Redact email addresses', kind: 'regex', pattern: '[\\w.+-]+@[\\w-]+\\.[\\w.]+', action: 'redact', phase: 2, enabled: true, createdAt: daysAgo(150), updatedAt: daysAgo(30) },
    { id: 'flt_3', name: 'Redact card-like numbers', kind: 'regex', pattern: '\\b(?:\\d[ -]?){13,19}\\b', action: 'redact', phase: 2, enabled: true, createdAt: daysAgo(120), updatedAt: daysAgo(120) },
    { id: 'flt_4', name: 'Block the incident marker', kind: 'exact', pattern: 'PROJECT-ORION-DO-NOT-LOG', action: 'block', phase: 1, enabled: true, createdAt: daysAgo(90), updatedAt: daysAgo(90) },
    { id: 'flt_5', name: 'Redact internal hostnames', kind: 'regex', pattern: '\\b[a-z0-9-]+\\.internal\\.example\\b', action: 'redact', phase: 2, enabled: false, createdAt: daysAgo(60), updatedAt: daysAgo(7) },
    { id: 'flt_6', name: 'Block competitor comparisons', kind: 'exact', pattern: 'ignore all previous instructions', action: 'block', phase: 1, enabled: true, createdAt: daysAgo(45), updatedAt: daysAgo(45) },
  ];
}
