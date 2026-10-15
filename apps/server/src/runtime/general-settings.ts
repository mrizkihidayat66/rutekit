import { generalSettingsSchema, type GeneralSettings } from '@contracts';

import { META_KEYS, type AppMetaRepository } from '@server/persistence/app-meta.ts';
import { mergePatch, type PatchOf } from '@server/runtime/patch.ts';

/**
 * The instance's general settings (FR-12.2, and the two switches routing reads).
 *
 * One JSON row in `app_meta`, the same shape `token-saver.ts` uses and for the
 * same reason: there is exactly one record, an operator replaces it whole, and a
 * table would buy a migration and a repository for a value nothing queries except
 * by its own key.
 *
 * Two of these fields are read on the hot path rather than only by the Settings
 * page:
 *
 *   - `lowStressMode` is read by the planner on every turn, because it is a
 *     routing decision — see `plan/plan.ts`.
 *   - `payloadCaptureEnabled` and `payloadCaptureTtlMinutes` are read by the
 *     telemetry recorder, and the TTL is what keeps a captured body from
 *     outliving its usefulness (SEC-6).
 *
 * Reading never throws and never returns a partial record: a row hand-edited into
 * something the contract no longer describes falls back to the defaults, the same
 * fail-open rule the Token Saver follows. A broken settings row must not be the
 * reason a turn fails.
 *
 * `instanceName` defaults to the empty string rather than to a product name,
 * because the auth service owns the real one — it is set during first-run setup
 * and stored beside the password. An empty value here means "not overridden",
 * which is what the Settings page checks before falling back.
 */

export function defaultGeneralSettings(): GeneralSettings {
  return {
    instanceName: '',
    lowStressMode: false,
    telemetryRetentionMinutes: 24 * 60,
    payloadCaptureEnabled: false,
    payloadCaptureTtlMinutes: 15,
    defaultProviderId: null,
    logLevel: 'info',
  };
}

/** A patch over the record; see `patch.ts` for why it is not `Partial`. */
export type GeneralSettingsPatch = PatchOf<GeneralSettings>;

export interface GeneralSettingsStore {
  read(): GeneralSettings;
  write(patch: GeneralSettingsPatch): GeneralSettings;
}

export function createGeneralSettings(deps: {
  readonly meta: AppMetaRepository;
}): GeneralSettingsStore {
  function stored(): unknown {
    const raw = deps.meta.get(META_KEYS.generalSettings);
    if (raw === null) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  return {
    read(): GeneralSettings {
      const parsed = generalSettingsSchema.safeParse(stored());
      return parsed.success ? parsed.data : defaultGeneralSettings();
    },

    write(patch: GeneralSettingsPatch): GeneralSettings {
      // Merged over the stored record rather than over the defaults, so a patch
      // that names one field cannot reset the rest — the same rule the console's
      // PATCH schemas follow, applied to a record with no schema of its own.
      const next = mergePatch(this.read(), patch);
      deps.meta.set(META_KEYS.generalSettings, JSON.stringify(next));
      return next;
    },
  };
}
