import { RTK_PRESET_FILTERS, tokenSaverConfigSchema, type TokenSaverConfig } from '@contracts';

import { META_KEYS, type AppMetaRepository } from '@server/persistence/app-meta.ts';
import { mergePatch, type PatchOf } from '@server/runtime/patch.ts';

/**
 * The Token Saver settings record (FR-1.2 / A3).
 *
 * Kept as one JSON row in `app_meta` rather than in a table of its own: there is
 * exactly one of it, an operator replaces it whole, and a table would buy a
 * migration and a repository for a value that is never queried by anything but
 * its own primary key. `tokenSaverConfigSchema` is the shape, so the record the
 * console edits and the record this process compresses with are the same object
 * by construction rather than by convention.
 *
 * Reading never throws. A row hand-edited into something the contract no longer
 * describes falls back to the defaults — the same fail-open rule the stages
 * themselves follow (CONTRIBUTING §5.5). A broken settings row must not be the
 * reason a turn fails, and the pipeline it feeds would rather save nothing than
 * refuse a request.
 */

/**
 * What the Token Saver starts as: everything lossless-ish on, Caveman off.
 *
 * The console's own fixture declares the same defaults, and that is deliberate —
 * the page an operator first sees and the behaviour they first get are the same
 * configuration. Caveman is the one stage left off, because it rewrites prose
 * rather than dropping what is provably redundant, and that is a choice an
 * operator should make rather than inherit.
 */
export function defaultTokenSaverConfig(now: Date = new Date()): TokenSaverConfig {
  return {
    enabled: true,
    stages: { tsc: true, dcp: true, rtk: true, caveman: false, cacheMarkers: true },
    rtkPreset: 'balanced',
    rtkFilters: { ...RTK_PRESET_FILTERS.balanced },
    cavemanTier: 'off',
    updatedAt: now.toISOString(),
  };
}

/** A patch over the record; see `patch.ts` for why it is not `Partial`. */
export type TokenSaverPatch = PatchOf<TokenSaverConfig>;

export interface TokenSaverSettings {
  /** The stored record, or the defaults when nothing usable is stored. */
  read(): TokenSaverConfig;
  /**
   * Merge a patch over the stored record, stamping `updatedAt`.
   *
   * A merge rather than a replace, and the same rule the customization and
   * general-settings stores follow: the console's PATCH schema makes every field
   * optional, so a page that moved one switch sends one field, and a write that
   * replaced the record would reset every stage the operator did not touch.
   */
  write(patch: TokenSaverPatch): TokenSaverConfig;
}

export interface TokenSaverSettingsDeps {
  readonly meta: AppMetaRepository;
  readonly now?: () => Date;
}

export function createTokenSaverSettings(deps: TokenSaverSettingsDeps): TokenSaverSettings {
  const now = deps.now ?? ((): Date => new Date());

  function stored(): unknown {
    const raw = deps.meta.get(META_KEYS.tokenSaver);
    if (raw === null) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  return {
    read(): TokenSaverConfig {
      const parsed = tokenSaverConfigSchema.safeParse(stored());
      return parsed.success ? parsed.data : defaultTokenSaverConfig(now());
    },

    write(patch: TokenSaverPatch): TokenSaverConfig {
      // Merged over what `read()` answers rather than over the defaults, so the
      // patch is applied to the record the operator is looking at — including
      // when the stored row was unreadable and `read()` fell back.
      const stamped: TokenSaverConfig = {
        ...mergePatch(this.read(), patch),
        updatedAt: now().toISOString(),
      };
      deps.meta.set(META_KEYS.tokenSaver, JSON.stringify(stamped));
      return stamped;
    },
  };
}
