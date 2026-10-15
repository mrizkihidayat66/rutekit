import { migration0001 } from './0001-init.ts';
import { migration0002 } from './0002-auth.ts';
import { migration0003 } from './0003-provider-accounts.ts';
import { migration0004 } from './0004-account-pool.ts';
import { migration0005 } from './0005-routing.ts';
import { migration0006 } from './0006-telemetry.ts';
import { migration0007 } from './0007-automation-pools.ts';
import { migration0008 } from './0008-jobs.ts';
import { migration0009 } from './0009-vcc.ts';
import { migration0010 } from './0010-filter-rules.ts';
import { migration0011 } from './0011-chat.ts';
import { migration0012 } from './0012-studio.ts';
import { migration0013 } from './0013-benchmark.ts';
import { migration0014 } from './0014-verification.ts';
import { migration0015 } from './0015-provider-overrides.ts';
import { migration0016 } from './0016-token-saver-savings.ts';
import type { Migration } from './types.ts';

/**
 * Every migration, in order. Append here; never edit an entry that has shipped.
 */
export const migrations: readonly Migration[] = [
  migration0001,
  migration0002,
  migration0003,
  migration0004,
  migration0005,
  migration0006,
  migration0007,
  migration0008,
  migration0009,
  migration0010,
  migration0011,
  migration0012,
  migration0013,
  migration0014,
  migration0015,
  migration0016,
];
