import { customizationSchema, type Customization } from '@contracts';

import { META_KEYS, type AppMetaRepository } from '@server/persistence/app-meta.ts';
import { mergePatch, type PatchOf } from '@server/runtime/patch.ts';

/**
 * The operator's appearance settings (C13b).
 *
 * One JSON row in `app_meta`, the same shape `general-settings.ts` and
 * `token-saver.ts` use and for the same reason: there is exactly one record, an
 * operator replaces it whole, and a table would buy a migration and a repository
 * for a value nothing queries except by its own key.
 *
 * **The defaults are the console's own fixture.** The page an operator first sees
 * and the values they first get are the same configuration, which is what keeps a
 * fresh install from rendering one way and then snapping to another the first
 * time something is saved.
 *
 * **Nothing here is read on the hot path.** The appearance is the console's, and
 * the data plane never looks at it — unlike `lowStressMode`, which the planner
 * reads on every turn. That is why this store is not on `deps` beside the general
 * settings: a route that needs it builds it, and nothing else has to know it
 * exists.
 *
 * Reading never throws and never returns a partial record. A row hand-edited into
 * something the contract no longer describes falls back to the defaults, which is
 * the fail-open rule the rest of the settings follow — an unreadable appearance
 * row must not be the reason a page fails to render.
 */

export function defaultCustomization(): Customization {
  return {
    theme: 'system',
    brandingIconUrl: null,
    backgroundKind: 'none',
    backgroundUrl: null,
    backgroundOpacity: 0.5,
    backgroundBlurPx: 0,
    glassEnabled: true,
    glassDepth: 2,
    ambientGlow: true,
  };
}

/** A patch over the record; see `patch.ts` for why it is not `Partial`. */
export type CustomizationPatch = PatchOf<Customization>;

export interface CustomizationStore {
  read(): Customization;
  /** Merge a patch over the stored record, and answer with what was written. */
  write(patch: CustomizationPatch): Customization;
}

export function createCustomizationStore(deps: {
  readonly meta: AppMetaRepository;
}): CustomizationStore {
  function stored(): unknown {
    const raw = deps.meta.get(META_KEYS.customization);
    if (raw === null) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  return {
    read(): Customization {
      const parsed = customizationSchema.safeParse(stored());
      return parsed.success ? parsed.data : defaultCustomization();
    },

    write(patch: CustomizationPatch): Customization {
      // Merged over the stored record rather than over the defaults, so a patch
      // that names one field cannot reset the rest — the same rule the console's
      // PATCH schemas follow, applied to a record with no schema of its own.
      const next = mergePatch(this.read(), patch);
      deps.meta.set(META_KEYS.customization, JSON.stringify(next));
      return next;
    },
  };
}
