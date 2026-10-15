import type { Job, JobStatus, SortDirection } from '@contracts';

import { JOB_STATUSES, isJobStatus } from '@web/components/patterns/job-vocabulary.ts';

/**
 * The Automation Logs page's own vocabulary.
 *
 * Kept out of the components so those files stay components-only for the
 * fast-refresh boundary, and so the table, the toolbar and the drawer agree on
 * the handful of things they share: what the filters mean before they become
 * query parameters, and which fields the history can be ordered by.
 *
 * The status filter is the job vocabulary with an "any" in front of it, exactly
 * the shape the launcher uses for providers — a filter has to be able to say
 * "do not narrow", and the endpoint's `null` is not something a select can hold.
 */

/** The provider filter's own "do not narrow" value, since a select needs one. */
export const ANY_PROVIDER = '';

/** The status filter: any status, or one of the seven. */
export type StatusFilter = 'all' | JobStatus;

/** Every value the filter may hold, for validating what the URL hands back. */
export const STATUS_FILTERS: readonly StatusFilter[] = ['all', ...JOB_STATUSES];

export function isStatusFilter(value: string): value is StatusFilter {
  return value === 'all' || isJobStatus(value);
}

/** What the endpoint wants: a real status, or null to leave the list whole. */
export function statusParam(filter: StatusFilter): JobStatus | null {
  return filter === 'all' ? null : filter;
}

/**
 * What the history can be ordered by.
 *
 * Deliberately short. The default — newest first — is what a history is for, and
 * the rest are the questions an operator actually asks of one: which provider,
 * and which batch was the biggest. The status is not here because sorting seven
 * states alphabetically would put "cancelled" first and mean nothing.
 */
export const JOB_SORT_KEYS = ['createdAt', 'startedAt', 'finishedAt', 'providerId', 'total'] as const;
export type JobSortKey = (typeof JOB_SORT_KEYS)[number];

export const DEFAULT_JOB_SORT: JobSortKey = 'createdAt';

export function isJobSortKey(value: string): value is JobSortKey {
  return JOB_SORT_KEYS.includes(value as JobSortKey);
}

export const JOB_DIRECTIONS: readonly SortDirection[] = ['asc', 'desc'];
export const DEFAULT_JOB_DIRECTION: SortDirection = 'desc';

export function isJobDirection(value: string): value is SortDirection {
  return value === 'asc' || value === 'desc';
}

/** A batch is one row per job, and jobs are far rarer than keys or models. */
export const JOB_PAGE_SIZE = 50;

/** Whether anything is narrowing the list, so "Clear filters" can appear. */
export function jobNarrowed(search: string, provider: string, status: StatusFilter): boolean {
  return search.trim() !== '' || provider !== ANY_PROVIDER || status !== 'all';
}

/**
 * How long a job ran, or null while it is still going.
 *
 * A job with no finish has no duration to report, and the alternative — counting
 * up from its start — would put a figure in a sortable column that means
 * something different from every other figure in it.
 */
export function jobDuration(job: Job): number | null {
  if (job.startedAt === null || job.finishedAt === null) return null;
  const ms = Date.parse(job.finishedAt) - Date.parse(job.startedAt);
  return ms >= 0 ? ms : null;
}
