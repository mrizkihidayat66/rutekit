import type {
  AuthStatus,
  BackupBody,
  Customization,
  CustomizationUpdate,
  GeneralSettings,
  GeneralSettingsUpdate,
  LoginBody,
  PasswordChangeBody,
  RestoreBody,
  SetupBody,
} from '@contracts';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { queryKeys } from '@web/data/query-keys.ts';
import { archiveFilename, downloadText } from '@web/lib/download.ts';
import {
  changePassword,
  fetchAuthStatus,
  fetchBackupManifest,
  fetchCustomization,
  fetchGeneralSettings,
  login,
  logout,
  restoreBackup,
  setupInstance,
  startBackup,
  updateCustomization,
  updateGeneralSettings,
} from '@web/data/system.ts';

/**
 * The System section's query hooks.
 *
 * Both records here are *configuration*, which changes the shape of the
 * mutations: they are written optimistically and the cache is the thing the UI
 * reads, so a toggle flips on the click rather than a round trip later. That is
 * not just polish — the appearance record is what `AppearanceLayer` paints the
 * console from, so an optimistic write is the difference between dragging an
 * opacity slider and watching it catch up.
 *
 * A failed write rolls the cache back, and every settle re-reads the server so
 * the two cannot drift after a rejected patch.
 */

/** Configuration only moves when the operator moves it. */
const CONFIG_STALE = 30_000;

/**
 * A patch that may name a field without giving it a value.
 *
 * Zod's `.partial()` produces `field?: T | undefined`, which is not the same
 * type as `Partial<T>` once `exactOptionalPropertyTypes` is on. Spelling the
 * looser shape out here is what lets the mutation variables be passed straight
 * through; the spread below drops the `undefined`s, so a patch that mentions a
 * field it does not set cannot blank it.
 */
type Patch<T> = { [K in keyof T]?: T[K] | undefined };

function patchIn<T extends object>(
  client: QueryClient,
  key: readonly unknown[],
  patch: Patch<T>,
): () => void {
  void client.cancelQueries({ queryKey: key });
  const previous = client.getQueryData<T>(key);
  if (previous !== undefined) {
    client.setQueryData<T>(key, { ...previous, ...patch });
  }
  return () => {
    if (previous !== undefined) client.setQueryData<T>(key, previous);
  };
}

/* ---- Appearance ---- */

export function useCustomization() {
  return useQuery({
    queryKey: queryKeys.customization(),
    queryFn: ({ signal }) => fetchCustomization(signal),
    staleTime: CONFIG_STALE,
  });
}

export function useUpdateCustomization() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: CustomizationUpdate) => updateCustomization(patch),
    onMutate: (patch) => patchIn<Customization>(client, queryKeys.customization(), patch),
    onError: (_error, _patch, rollback) => {
      if (typeof rollback === 'function') rollback();
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: queryKeys.customization() });
    },
  });
}

/**
 * The brand mark and the instance name, with the shell's own defaults behind
 * them.
 *
 * The sidebar renders before either record has arrived, so this returns
 * something usable from the first frame and fills in when the answer lands. It
 * exists so the rail does not have to know which of the two endpoints owns which
 * field, or that there are two at all.
 */
export function useBranding(): { iconUrl: string | null; name: string } {
  const customization = useCustomization();
  const general = useGeneralSettings();
  return {
    iconUrl: customization.data?.brandingIconUrl ?? null,
    name: general.data?.instanceName ?? 'rutekit',
  };
}

/* ---- General ---- */

export function useGeneralSettings() {
  return useQuery({
    queryKey: queryKeys.generalSettings(),
    queryFn: ({ signal }) => fetchGeneralSettings(signal),
    staleTime: CONFIG_STALE,
  });
}

export function useUpdateGeneralSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: GeneralSettingsUpdate) => updateGeneralSettings(patch),
    onMutate: (patch) => patchIn<GeneralSettings>(client, queryKeys.generalSettings(), patch),
    onError: (_error, _patch, rollback) => {
      if (typeof rollback === 'function') rollback();
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: queryKeys.generalSettings() });
    },
  });
}

/* ---- Auth ---- */

export function useAuthStatus() {
  return useQuery({
    queryKey: queryKeys.authStatus(),
    queryFn: ({ signal }) => fetchAuthStatus(signal),
    staleTime: CONFIG_STALE,
  });
}

/**
 * The first run: name the instance and set its password.
 *
 * The response is written straight into the cache rather than invalidated,
 * because `AuthGate` reads this record to decide whether the console may be
 * shown at all — an invalidation would leave the wizard on screen for another
 * round trip after it had already succeeded. The general settings are dropped
 * because the wizard's other answer is the instance name the shell brands
 * itself with.
 */
export function useSetupInstance() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: SetupBody) => setupInstance(body),
    onSuccess: (status) => {
      client.setQueryData(queryKeys.authStatus(), status);
      void client.invalidateQueries({ queryKey: queryKeys.generalSettings() });
    },
  });
}

export function useLogin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: LoginBody) => login(body),
    onSuccess: (status) => {
      client.setQueryData(queryKeys.authStatus(), status);
    },
  });
}

/**
 * Change the password.
 *
 * Nothing is invalidated on success: the session survives a password change, so
 * the auth record the page is showing is still correct and a refetch would only
 * make the confirmation flicker.
 */
export function useChangePassword() {
  return useMutation({
    mutationFn: (body: PasswordChangeBody) => changePassword(body),
  });
}

/**
 * End the session.
 *
 * The signed-out record is written rather than invalidated, and for the same
 * reason as the wizard: the guard is watching it, and an invalidation would keep
 * the console — and the rail full of pages the visitor can no longer open — on
 * screen until a refetch came back to say otherwise. `configured` is carried
 * over from the record already in hand, so logging out cannot be mistaken for
 * an instance that was never set up.
 */
export function useLogout() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => logout(),
    onSuccess: () => {
      const previous = client.getQueryData<AuthStatus>(queryKeys.authStatus());
      client.setQueryData(queryKeys.authStatus(), {
        configured: previous?.configured ?? true,
        authenticated: false,
        sessionExpiresAt: null,
      });
    },
  });
}

/* ---- Backup & restore ---- */

export function useBackupManifest() {
  return useQuery({
    queryKey: queryKeys.backupManifest(),
    queryFn: ({ signal }) => fetchBackupManifest(signal),
    staleTime: CONFIG_STALE,
  });
}

/**
 * Export the instance.
 *
 * The archive arrives in the response body and is saved from here rather than
 * left for the page to do, so that the download happens once per successful
 * export and cannot be lost by a component that re-rendered first. The mutation's
 * `data` is still the archive, which is what the page reads to say what was
 * written.
 */
export function useStartBackup() {
  return useMutation({
    mutationFn: (body: BackupBody) => startBackup(body),
    onSuccess: (archive) => {
      downloadText(
        archiveFilename(archive.createdAt),
        'application/json',
        `${JSON.stringify(archive, null, 2)}\n`,
      );
    },
  });
}

/**
 * Restore from an archive.
 *
 * Everything cached is dropped on success rather than invalidated: the archive
 * replaces the database, so every list, detail and count in the console
 * describes a world that no longer exists. Invalidating would refetch each one;
 * clearing forgets them and the pages that are still mounted refetch on their own.
 */
export function useRestore() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: RestoreBody) => restoreBackup(body),
    onSuccess: () => {
      client.clear();
    },
  });
}
