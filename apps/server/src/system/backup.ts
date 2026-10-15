import type {
  BackupArchive,
  BackupBody,
  BackupManifest,
  RestoreBody,
  RestoreResult,
} from '@contracts';
import { backupArchiveSchema, backupManifestSchema } from '@contracts';
import type { SQLQueryBindings } from 'bun:sqlite';
import type { Logger } from 'pino';

/**
 * One archived value, as something the driver will bind.
 *
 * The archive's values are `unknown` by contract — a dump does not carry a type
 * per column, and a schema that did would be a second `schema.ts` to keep in step
 * with every migration. So this is where that ends: anything SQLite can store is
 * passed through, and anything it cannot becomes NULL rather than reaching the
 * driver as an object it would refuse.
 *
 * A boolean is converted rather than passed, because SQLite has no boolean type
 * and a JS `true` binds as the integer 1 only if the driver is the one deciding.
 * The rows came from a `select *`, so they carry integers here — but an archive is
 * a file a person may have edited, and `"free_tier": true` is the obvious thing
 * for them to write.
 */
function toBinding(value: unknown): SQLQueryBindings {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'bigint') {
    return value;
  }
  if (value instanceof Uint8Array) return value;
  return null;
}

import { AppError } from '@server/errors.ts';
import type { Persistence } from '@server/persistence/client.ts';
import { currentSchemaVersion } from '@server/persistence/migrate.ts';
import { SERVER_VERSION } from '@server/version.ts';

/**
 * Exporting the instance and putting it back (C13b, SEC-6).
 *
 * A JSON dump of every restorable table, and a restore that replaces them in one
 * transaction. Three rules shape the whole file, and each exists because the
 * alternative is a way to lose data.
 *
 * **The authentication state never leaves, whatever the operator asks for.**
 * `auth_credential` (the password hash) and `sessions` (the live logins) are
 * always omitted, and the archive says so in `omitted`. A restore is the
 * configuration of an instance, not who may open it: an archive that carried a
 * password would be a file that can lock an operator out of their own instance
 * the moment they have changed it since — and the only way back would be editing
 * SQLite by hand. It also means a restore cannot end the session it was made
 * from, which is the difference between an operation you can undo and one you
 * cannot.
 *
 * **Credentials leave only when asked for, and they leave as ciphertext.**
 * `includeCredentials` defaults to false, because an export that quietly carried
 * every provider key, every account token and every card number would be the
 * single most damaging file to leak. When it is true the envelopes are copied
 * *as stored* — already encrypted by the `SecretBox` — so the archive is only
 * readable by an instance holding the same `RUTEKIT_ENCRYPTION_KEY`. That is
 * stated in the archive rather than left for the reader to work out.
 *
 * **A restore replaces, in one transaction, and refuses an archive from a newer
 * schema.** Replacing is what "restore" means: a merge would produce a mixture of
 * two instances that never existed, and there would be no way back. One
 * transaction is what makes a failure a no-op rather than a half-written
 * database. Refusing a newer archive is the one direction that cannot be
 * recovered from — an older build does not know what a newer column means, and a
 * row written without it is a row that lies.
 *
 * **Every identifier is checked against the live schema.** A table name comes
 * from a file an operator uploads, and a column name from the rows inside it.
 * Both are validated against `sqlite_master` and `pragma table_info` before any
 * SQL is built, and the *only* identifiers that reach a statement are ones that
 * check read back — so a crafted archive cannot name a table rutekit does not
 * have, or a column it does not have, no matter what the file says.
 *
 * Values, by contrast, are always bound and never interpolated: nothing in an
 * archive is ever parsed as SQL, whatever it contains.
 */

/**
 * Tables a restore replaces, and the columns that are dropped from them.
 *
 * Listed explicitly rather than discovered from `sqlite_master`, and that is a
 * safety property: a table discovered at runtime would include one added later
 * without anyone deciding whether it *should* be restorable. `omittedColumns`
 * names the credential envelopes that only leave when the operator asks.
 *
 * `app_meta` is not here. It holds the boot timestamp and the settings records,
 * and a restore that replaced it would rewrite the settings a restore just read —
 * including the appearance, mid-request. The settings that belong to the operator
 * are restored through their own tables and records, not as a side effect of an
 * archive.
 */
interface RestorableTable {
  readonly name: string;
  /** Columns dropped from the archive unless credentials were requested. */
  readonly credentialColumns?: readonly string[];
}

export const RESTORABLE_TABLES: readonly RestorableTable[] = [
  { name: 'providers' },
  { name: 'provider_models' },
  {
    name: 'provider_accounts',
    credentialColumns: ['credential_envelope'],
  },
  { name: 'api_keys' },
  { name: 'aliases' },
  { name: 'combos' },
  { name: 'combo_entries' },
  { name: 'model_mappings' },
  { name: 'filter_rules' },
  { name: 'proxies', credentialColumns: ['credential_envelope'] },
  { name: 'sms_providers', credentialColumns: ['credential_envelope'] },
  { name: 'vcc_cards', credentialColumns: ['pan_envelope', 'cvv_envelope'] },
  { name: 'jobs', credentialColumns: ['payload_envelope'] },
  { name: 'job_items' },
  { name: 'chat_sessions' },
  { name: 'chat_messages' },
  { name: 'studio_generations' },
  { name: 'studio_assets' },
  { name: 'benchmark_runs' },
  { name: 'benchmark_results' },
  { name: 'verification_results' },
  { name: 'verification_baselines' },
  { name: 'requests' },
  { name: 'request_captures' },
];

/**
 * Tables deliberately left out of every archive, and why.
 *
 * Named rather than silently absent, because the archive reports what it omitted
 * and "why is my password not in here" is a question the file itself should
 * answer.
 */
export const NEVER_ARCHIVED: readonly { readonly table: string; readonly reason: string }[] = [
  {
    table: 'auth_credential',
    reason: 'The instance password. A restore replaces the configuration, not who may open it.',
  },
  {
    table: 'sessions',
    reason: 'Live console logins. Restoring them would resurrect sessions an operator ended.',
  },
  {
    table: 'app_meta',
    reason: 'Boot metadata and the settings records, which are restored through their own paths.',
  },
];

/** The marker written where a credential would have been. */
export const REDACTED = '[redacted]';

export interface BackupService {
  manifest(): BackupManifest;
  export(body: BackupBody): BackupArchive;
  restore(body: RestoreBody): RestoreResult;
}

export interface BackupServiceDeps {
  readonly persistence: Persistence;
  readonly logger: Logger;
  readonly now?: () => Date;
}

export function createBackupService(deps: BackupServiceDeps): BackupService {
  const now = deps.now ?? ((): Date => new Date());
  const sqlite = deps.persistence.sqlite;

  /** Whether a table exists, asked of SQLite rather than assumed. */
  function tableExists(name: string): boolean {
    const row = sqlite
      .query("select name from sqlite_master where type = 'table' and name = ?")
      .get(name);
    return row !== null;
  }

  /** The columns a table actually has, so an archive cannot invent one. */
  function columnsOf(name: string): readonly string[] {
    const rows = sqlite.query(`pragma table_info("${name}")`).all() as { name: string }[];
    return rows.map((row) => row.name);
  }

  function dump(includeCredentials: boolean): Record<string, Record<string, unknown>[]> {
    const tables: Record<string, Record<string, unknown>[]> = {};

    for (const table of RESTORABLE_TABLES) {
      // A table a migration has not created yet is skipped rather than fatal: an
      // older instance exporting what it has is a legitimate archive.
      if (!tableExists(table.name)) continue;

      const rows = sqlite.query(`select * from "${table.name}"`).all() as Record<string, unknown>[];
      const dropped = new Set(includeCredentials ? [] : (table.credentialColumns ?? []));

      tables[table.name] = rows.map((row) => {
        if (dropped.size === 0) return row;
        const copy: Record<string, unknown> = { ...row };
        for (const column of dropped) {
          // Present but empty, rather than absent: a restore reads the archive
          // back into the same columns, and a missing key would be a column the
          // restore has to guess about. `[redacted]` also reads as a marker in a
          // file a person opens.
          if (column in copy) copy[column] = REDACTED;
        }
        return copy;
      });
    }

    return tables;
  }

  function countTables(tables: Record<string, Record<string, unknown>[]>): Record<string, number> {
    return Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.length]));
  }

  return {
    manifest(): BackupManifest {
      const tables = dump(false);
      return backupManifestSchema.parse({
        version: SERVER_VERSION,
        createdAt: now().toISOString(),
        // The manifest describes what a backup *would* contain, and the default is
        // the safe one — so it reports false rather than claiming credentials it
        // would not carry.
        includesCredentials: false,
        tableCounts: countTables(tables),
      });
    },

    export(body: BackupBody): BackupArchive {
      const archive = backupArchiveSchema.parse({
        format: 1,
        schemaVersion: currentSchemaVersion(sqlite),
        version: SERVER_VERSION,
        createdAt: now().toISOString(),
        includesCredentials: body.includeCredentials,
        tables: dump(body.includeCredentials),
        omitted: [...NEVER_ARCHIVED],
      });

      deps.logger.info(
        {
          includesCredentials: body.includeCredentials,
          tables: Object.keys(archive.tables).length,
        },
        'instance exported',
      );
      return archive;
    },

    restore(body: RestoreBody): RestoreResult {
      const archive = parseArchive(body.archive);
      const live = currentSchemaVersion(sqlite);

      if (archive.schemaVersion > live) {
        // The one direction that cannot be recovered from: an older build does
        // not know what a newer column means, and a row written without it is a
        // row that lies about its own schema.
        throw AppError.invalidRequest(
          `This archive was written at schema ${String(archive.schemaVersion)}, and this instance is at ${String(live)}. Upgrade rutekit before restoring it.`,
        );
      }

      const known = new Set(RESTORABLE_TABLES.map((table) => table.name));
      const skipped: { table: string; reason: string }[] = [];
      const replaceable: {
        table: string;
        rows: Record<string, unknown>[];
        columns: readonly string[];
      }[] = [];

      for (const [name, rows] of Object.entries(archive.tables)) {
        if (!known.has(name)) {
          skipped.push({ table: name, reason: 'rutekit does not restore this table.' });
          continue;
        }
        if (!tableExists(name)) {
          skipped.push({ table: name, reason: 'this instance has no such table.' });
          continue;
        }

        // Every column the archive names has to exist here. A row carrying a
        // column this build does not have is either an archive from the future or
        // a hand-edited file, and either way the honest answer is to refuse it
        // rather than to write the columns it does recognise.
        const columns = columnsOf(name);
        const present = new Set(columns);
        const unknownColumn = rows
          .flatMap((row) => Object.keys(row))
          .find((column) => !present.has(column));
        if (unknownColumn !== undefined) {
          skipped.push({
            table: name,
            reason: `the archive carries a column this instance does not have (${unknownColumn}).`,
          });
          continue;
        }

        replaceable.push({ table: name, rows, columns });
      }

      const untouched = RESTORABLE_TABLES.filter(
        (table) => !Object.hasOwn(archive.tables, table.name),
      ).map((table) => table.name);

      let written = 0;
      // One transaction for the whole restore: a failure part-way leaves the
      // database exactly as it was, which is the difference between an operation
      // an operator can retry and one that has to be repaired by hand.
      sqlite.transaction(() => {
        for (const { table, rows, columns } of replaceable) {
          sqlite.query(`delete from "${table}"`).run();
          if (rows.length === 0) continue;

          // Built from the validated column list, never from the archive's own
          // keys — the check above proved they are a subset, and this is what
          // makes the statement's identifiers come from the schema rather than
          // from the file.
          const names = columns.filter((column) => rows.some((row) => Object.hasOwn(row, column)));
          const quoted = names.map((column) => `"${column}"`).join(', ');
          const placeholders = names.map(() => '?').join(', ');
          const insert = sqlite.query(
            `insert into "${table}" (${quoted}) values (${placeholders})`,
          );

          for (const row of rows) {
            // Bound positionally, in the order the columns were named.
            //
            // Not a named-parameter object: bun:sqlite matches those against the
            // statement's parameter *tokens*, which include the `$` sigil, so an
            // object keyed `id` binds nothing to `$id` — it fails a NOT NULL
            // column loudly and, worse, writes NULL into a nullable one. The
            // values still come from the archive and are still bound rather than
            // interpolated, so nothing in the file is ever parsed as SQL; this
            // only decides how the driver is told which value goes where.
            insert.run(...names.map((column) => toBinding(row[column])));
            written += 1;
          }
        }
      })();

      deps.logger.warn(
        { tables: replaceable.length, rows: written, skipped: skipped.length },
        'instance restored from an archive',
      );

      return {
        ok: true,
        tables: replaceable.length,
        rows: written,
        untouched,
        skipped,
      };
    },
  };
}

/**
 * The archive in a request body, decoded and validated.
 *
 * Base64, because the archive is a document that already carries its own quoting
 * and newlines and putting it in a JSON string field unencoded means every reader
 * has to be sure it round-trips exactly. A body that is not base64, or not the
 * archive's shape, is a refusal rather than a partial restore.
 */
function parseArchive(encoded: string): BackupArchive {
  let text: string;
  try {
    text = Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    throw AppError.invalidRequest('The archive could not be decoded.');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw AppError.invalidRequest('The archive is not a rutekit backup.');
  }

  const parsed = backupArchiveSchema.safeParse(raw);
  if (!parsed.success) {
    throw AppError.invalidRequest('The archive is not a rutekit backup.');
  }
  return parsed.data;
}
