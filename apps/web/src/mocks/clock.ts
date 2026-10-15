/**
 * Fixture timestamps are anchored to the moment the mock DB is built, not to a
 * fixed date, so the dashboard's "last hour" tiles and the usage charts always
 * have data inside the window an operator is looking at. The anchor is frozen
 * once per session so the pool does not drift between two renders.
 */
const ANCHOR = Date.now();

export function anchorMs(): number {
  return ANCHOR;
}

export function isoAt(offsetMs: number): string {
  return new Date(ANCHOR + offsetMs).toISOString();
}

export function minutesAgo(minutes: number): string {
  return isoAt(-minutes * 60_000);
}

export function hoursAgo(hours: number): string {
  return isoAt(-hours * 3_600_000);
}

export function daysAgo(days: number): string {
  return isoAt(-days * 86_400_000);
}

export function minutesFromNow(minutes: number): string {
  return isoAt(minutes * 60_000);
}

export function hoursFromNow(hours: number): string {
  return isoAt(hours * 3_600_000);
}

export function daysFromNow(days: number): string {
  return isoAt(days * 86_400_000);
}
