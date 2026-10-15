import type {
  MappingInput,
  MappingMatch,
  MappingPreviewResult,
  MappingUpdate,
  ModelMappingRule,
  SortDirection,
} from '@contracts';

/**
 * The Model Mapping page's vocabulary.
 *
 * A mapping rule rewrites the model id a client asked for, before anything else
 * looks at the request. That makes it the first thing an operator reaches for
 * when a provider retires a name and they would rather not chase every caller,
 * and the last thing they should have to reason about — which is why the page
 * states the order rules run in rather than leaving it implied by the list, and
 * why a rule's priority is a first-class column rather than a hidden field.
 *
 * Nothing here renders, so any component on the page may import it without
 * breaking fast refresh.
 */

/* ---- Match kinds ---- */

export const MATCH_KINDS = ['exact', 'contains', 'regex'] as const;

export const MATCH_LABELS: Record<MappingMatch, string> = {
  exact: 'Exact',
  contains: 'Contains',
  regex: 'Regex',
};

/** What each match kind does to the id, in one line. */
export const MATCH_HINTS: Record<MappingMatch, string> = {
  exact: 'The id must equal the pattern character for character.',
  contains: 'The pattern is looked for anywhere in the id and replaced where it sits.',
  regex: 'The pattern is a regular expression and its first match is replaced.',
};

export const MATCH_OPTIONS: readonly { readonly value: MappingMatch; readonly label: string }[] =
  MATCH_KINDS.map((value) => ({ value, label: MATCH_LABELS[value] }));

/* ---- Sorting ---- */

/**
 * The sortable fields. `priority` is the one that matters — it is the order the
 * rules run in — so it is the default and it reads ascending, lowest first.
 */
export const MAPPING_SORT_KEYS = ['priority', 'updatedAt'] as const;
export type MappingSortKey = (typeof MAPPING_SORT_KEYS)[number];

export const DEFAULT_MAPPING_SORT: MappingSortKey = 'priority';
export const DEFAULT_MAPPING_DIRECTION: SortDirection = 'asc';
export const MAPPING_DIRECTIONS: readonly SortDirection[] = ['asc', 'desc'];

export function isMappingSortKey(value: string): value is MappingSortKey {
  return MAPPING_SORT_KEYS.includes(value as MappingSortKey);
}

export function isMappingDirection(value: string): value is SortDirection {
  return MAPPING_DIRECTIONS.includes(value as SortDirection);
}

/**
 * How many rules a page holds. A rewrite list is configuration, not population:
 * a router with more than a couple of dozen rules is unusual, so one page is
 * normally everything and the cap only bounds the pathological case.
 */
export const MAPPING_PAGE_SIZE = 50;

/* ---- Drafts ---- */

/**
 * One rule being edited.
 *
 * `priority` is a string because this is form state: a number input the operator
 * is halfway through typing holds `''` or `'-'`, neither of which is a number,
 * and coercing on every keystroke would fight the person typing. The conversion
 * happens once, on submit.
 */
export interface RuleDraft {
  readonly match: MappingMatch;
  readonly pattern: string;
  readonly replacement: string;
  readonly priority: string;
  readonly description: string;
  readonly enabled: boolean;
}

export const EMPTY_DRAFT: RuleDraft = {
  match: 'exact',
  pattern: '',
  replacement: '',
  priority: '0',
  description: '',
  enabled: true,
};

export function draftFromRule(rule: ModelMappingRule): RuleDraft {
  return {
    match: rule.match,
    pattern: rule.pattern,
    replacement: rule.replacement,
    priority: String(rule.priority),
    description: rule.description ?? '',
    enabled: rule.enabled,
  };
}

/** A whole number, or `undefined` when the text is not one. Negative is fine. */
export function parsePriority(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) ? parsed : undefined;
}

/**
 * Why a regex will not compile, or `undefined` when it will.
 *
 * The engine's own message is passed through rather than replaced: it names the
 * offending position, which is the part the operator needs, and inventing a
 * friendlier sentence would only hide it.
 */
export function regexProblem(pattern: string): string | undefined {
  try {
    new RegExp(pattern);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : 'That is not a valid regular expression.';
  }
}

/**
 * What is wrong with the pattern alone, or `undefined` when it is fine. Separate
 * from `draftProblem` so the pattern field can mark itself invalid without the
 * dialog having to work out which of several problems the sentence refers to.
 */
export function patternProblem(draft: RuleDraft): string | undefined {
  if (draft.pattern.trim() === '') return 'The pattern cannot be empty.';
  if (draft.match !== 'regex') return undefined;
  const problem = regexProblem(draft.pattern);
  return problem === undefined ? undefined : `That is not a valid regular expression: ${problem}`;
}

/**
 * What is wrong with a draft, as one sentence, or `undefined` when it is
 * sendable. The order matters: an empty pattern is reported before the regex it
 * would also fail to compile as, because "it is empty" is the real problem.
 */
export function draftProblem(draft: RuleDraft): string | undefined {
  const pattern = patternProblem(draft);
  if (pattern !== undefined) return pattern;
  if (parsePriority(draft.priority) === undefined) return 'Priority must be a whole number.';
  return undefined;
}

/** The body a draft posts, or `undefined` when it is not sendable yet. */
export function inputFromDraft(draft: RuleDraft): MappingInput | undefined {
  if (draftProblem(draft) !== undefined) return undefined;
  const priority = parsePriority(draft.priority);
  if (priority === undefined) return undefined;
  const description = draft.description.trim();
  return {
    match: draft.match,
    pattern: draft.pattern,
    replacement: draft.replacement,
    priority,
    description: description === '' ? null : description,
    enabled: draft.enabled,
  };
}

/**
 * The priority a brand-new rule should start at: below everything that exists,
 * so the common case — add a rule, it applies last — needs no thought. Gaps of
 * ten leave room to slot a rule between two without renumbering the list.
 */
export function nextPriority(rules: readonly ModelMappingRule[]): number {
  if (rules.length === 0) return 0;
  return Math.max(...rules.map((rule) => rule.priority)) + 10;
}

/* ---- Preview ---- */

export type PreviewRow = MappingPreviewResult['results'][number];

/**
 * The ids a draft is tried against before it is saved.
 *
 * Chosen to be the shapes rules are actually written for — a retired name, a
 * dated snapshot, a versioned suffix, a name nothing should match — so the
 * default preview answers "does this do what I meant" without the operator
 * having to type anything.
 */
export const DEFAULT_SAMPLES = [
  'gpt-4-turbo',
  'gpt-4o-2024-08-06',
  'llama-3.1-405b-instruct',
  'text-davinci-003',
  'internal-fast',
  'some-model-preview',
];

/** One id per line, blanks dropped, in the order typed. */
export function parseSamples(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

export interface PreviewSummary {
  readonly rewritten: number;
  readonly matched: number;
  readonly total: number;
}

export function summarisePreview(rows: readonly PreviewRow[]): PreviewSummary {
  return {
    total: rows.length,
    matched: rows.filter((row) => row.matched).length,
    rewritten: rows.filter((row) => row.matched && row.output !== row.input).length,
  };
}

/** How a single preview row should read. */
export type PreviewVerdict = 'rewritten' | 'unchanged' | 'missed';

export function previewVerdict(row: PreviewRow): PreviewVerdict {
  if (!row.matched) return 'missed';
  return row.output === row.input ? 'unchanged' : 'rewritten';
}

/* ---- Draft comparison, for the JSON editor ---- */

/**
 * What changed between a saved rule and an edited copy of it, or `null` when
 * nothing did. Sending only the differences keeps a JSON round-trip from
 * touching `updatedAt` on every rule in the list.
 */
export function rulePatch(rule: ModelMappingRule, next: MappingInput): MappingUpdate | null {
  const patch: MappingUpdate = {};
  if (rule.match !== next.match) patch.match = next.match;
  if (rule.pattern !== next.pattern) patch.pattern = next.pattern;
  if (rule.replacement !== next.replacement) patch.replacement = next.replacement;
  if (rule.priority !== next.priority) patch.priority = next.priority;
  if ((rule.description ?? null) !== next.description) patch.description = next.description;
  if (rule.enabled !== next.enabled) patch.enabled = next.enabled;
  return Object.keys(patch).length === 0 ? null : patch;
}
