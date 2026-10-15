import type { Dispatch, SetStateAction } from 'react';

/**
 * The trail a detail route adds to the topbar's breadcrumb.
 *
 * The rail owns the first two crumbs — the section and the nav item — but a
 * detail route such as `/providers/:id` is not a rail entry: it is reached from
 * a list, and the name it should be titled with lives in the response that list
 * links to. So the page publishes the rest of the trail rather than the shell
 * trying to guess it from the path, which would mean teaching the chrome about
 * every domain's detail routes.
 */
export interface Crumb {
  readonly label: string;
  /** Where the crumb leads; the final crumb is the current page and has none. */
  readonly to?: string;
}

/**
 * What the shell hands its routes through `<Outlet context>`.
 *
 * Only the setter crosses the boundary: it is a stable state setter, so a page
 * can publish on mount and clear on unmount without the value churning a render
 * each time the shell redraws.
 */
export interface ShellOutletContext {
  readonly setBreadcrumbTrail: Dispatch<SetStateAction<readonly Crumb[] | null>>;
}
