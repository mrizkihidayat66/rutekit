import type { PasswordChangeBody, SetupBody } from '@contracts';

import { AppError } from '@server/errors.ts';
import type { AuthCredentialRepository } from '@server/persistence/auth-credential.ts';
import type { SessionRecord, SessionsRepository } from '@server/persistence/sessions.ts';
import { hashPassword, verifyPassword } from '@server/security/password.ts';
import { hashToken, mintSessionToken } from '@server/security/tokens.ts';

/**
 * Who may open this console (D8, ADR-0008).
 *
 * One password, one session cookie, no accounts. The password is the only thing
 * a human chooses and the only thing worth a slow hash; the session token is 256
 * random bits, minted here and stored as its hash, so the cookie value never
 * exists on the server's disk.
 *
 * The clock is injected rather than read, so every branch that depends on
 * expiry — the refusal, the slide, the sweep — is testable without waiting.
 */

const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;
/**
 * A session is slid forward only once it is past the halfway mark. Renewing on
 * every request would mean a write per request for no gain; never renewing would
 * log out an operator who is actively working.
 */
const RENEW_BELOW_MS = SESSION_LIFETIME_MS / 2;

/** The console's view of the caller. Exactly `authStatusSchema`, and nothing more. */
export interface AuthStatus {
  readonly configured: boolean;
  readonly authenticated: boolean;
  readonly sessionExpiresAt: string | null;
}

export interface IssuedSession {
  readonly status: AuthStatus;
  /** The cookie value. Returned once, to be set on the response and forgotten. */
  readonly token: string;
  readonly expiresAt: string;
}

export interface AuthService {
  /** The status a caller with this cookie value should be shown. */
  status(token: string | null): AuthStatus;
  /** The live session behind a cookie value, or `null`. Slides the expiry forward. */
  resolve(token: string | null): SessionRecord | null;
  setup(input: SetupBody): Promise<IssuedSession>;
  login(password: string): Promise<IssuedSession>;
  logout(token: string | null): void;
  /** `sessionId` is the caller's own session, which survives the change. */
  changePassword(input: PasswordChangeBody, sessionId: string): Promise<void>;
}

export interface AuthServiceDeps {
  readonly credentials: AuthCredentialRepository;
  readonly sessions: SessionsRepository;
  readonly authSecret: string | null;
  readonly now?: () => Date;
}

export function createAuthService(deps: AuthServiceDeps): AuthService {
  const now = deps.now ?? ((): Date => new Date());

  /** Look up a cookie value, dropping the row if it has already expired. */
  function liveSession(token: string | null): SessionRecord | null {
    if (token === null || token === '') return null;
    const record = deps.sessions.findByTokenHash(hashToken(token));
    if (record === null) return null;

    const at = now().getTime();
    if (Date.parse(record.expiresAt) <= at) {
      deps.sessions.delete(record.id);
      return null;
    }

    if (Date.parse(record.expiresAt) - at < RENEW_BELOW_MS) {
      const expiresAt = new Date(at + SESSION_LIFETIME_MS).toISOString();
      deps.sessions.touch(record.id, expiresAt);
      return { ...record, expiresAt };
    }
    return record;
  }

  function issue(): IssuedSession {
    const { token, hash } = mintSessionToken();
    const at = now();
    const expiresAt = new Date(at.getTime() + SESSION_LIFETIME_MS).toISOString();
    deps.sessions.create({
      id: crypto.randomUUID(),
      tokenHash: hash,
      createdAt: at.toISOString(),
      expiresAt,
    });
    return {
      token,
      expiresAt,
      status: { configured: true, authenticated: true, sessionExpiresAt: expiresAt },
    };
  }

  return {
    status(token: string | null): AuthStatus {
      const configured = deps.credentials.get() !== null;
      const session = configured ? liveSession(token) : null;
      return {
        configured,
        authenticated: session !== null,
        sessionExpiresAt: session?.expiresAt ?? null,
      };
    },

    resolve: liveSession,

    async setup(input: SetupBody): Promise<IssuedSession> {
      if (deps.credentials.get() !== null) {
        throw AppError.permission('This instance has already been set up.');
      }
      const at = now().toISOString();
      deps.credentials.create({
        id: crypto.randomUUID(),
        passwordHash: await hashPassword(input.password, deps.authSecret),
        instanceName: input.instanceName,
        createdAt: at,
        updatedAt: at,
      });
      return issue();
    },

    async login(password: string): Promise<IssuedSession> {
      const credential = deps.credentials.get();
      if (credential === null) {
        throw AppError.permission('This instance has not been set up yet.');
      }
      const matches = await verifyPassword(password, credential.passwordHash, deps.authSecret);
      if (!matches) throw AppError.authentication('That password is not correct.');
      return issue();
    },

    logout(token: string | null): void {
      if (token === null || token === '') return;
      const record = deps.sessions.findByTokenHash(hashToken(token));
      if (record !== null) deps.sessions.delete(record.id);
    },

    async changePassword(input: PasswordChangeBody, sessionId: string): Promise<void> {
      const credential = deps.credentials.get();
      if (credential === null) {
        throw AppError.permission('This instance has not been set up yet.');
      }
      const matches = await verifyPassword(
        input.currentPassword,
        credential.passwordHash,
        deps.authSecret,
      );
      if (!matches) throw AppError.authentication('The current password is not correct.');

      deps.credentials.updatePasswordHash(
        credential.id,
        await hashPassword(input.newPassword, deps.authSecret),
        now().toISOString(),
      );
      // Changing the password is a statement that the old one may be known, so
      // every session opened with it goes — except the one asking, which has
      // just proved it knows both.
      deps.sessions.deleteOthers(sessionId);
    },
  };
}
