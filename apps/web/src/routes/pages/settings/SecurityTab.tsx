import { LogOut, ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import { Badge } from '@web/components/ui/Badge.tsx';
import { Button } from '@web/components/ui/Button.tsx';
import { Card, CardBody, CardFooter, CardHeader } from '@web/components/ui/Card.tsx';
import { Field } from '@web/components/ui/Field.tsx';
import { Input } from '@web/components/ui/Input.tsx';
import { SkeletonText } from '@web/components/ui/Skeleton.tsx';
import { useAuthStatus, useChangePassword, useLogout } from '@web/hooks/use-system.ts';
import { formatDateTime, formatRelative } from '@web/lib/format.ts';

const MIN_LENGTH = 8;

interface Draft {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

const EMPTY: Draft = { currentPassword: '', newPassword: '', confirmPassword: '' };

type FieldName = keyof Draft;

/**
 * What is wrong with the draft, and which field should carry the complaint.
 *
 * The field is named rather than guessed at render time: "the new password is
 * the one you already have" is about two fields at once, and a validator that
 * returned only a string would leave the page with no honest place to put it.
 */
interface Problem {
  readonly field: FieldName;
  readonly message: string;
}

function validate(draft: Draft): Problem | null {
  if (draft.currentPassword === '') {
    return { field: 'currentPassword', message: 'Enter the password you are using now.' };
  }
  if (draft.newPassword.length < MIN_LENGTH) {
    return {
      field: 'newPassword',
      message: `The new password needs at least ${String(MIN_LENGTH)} characters.`,
    };
  }
  if (draft.newPassword === draft.currentPassword) {
    return { field: 'newPassword', message: 'The new password is the one you already have.' };
  }
  if (draft.newPassword !== draft.confirmPassword) {
    return { field: 'confirmPassword', message: 'The two new passwords do not match.' };
  }
  return null;
}

/**
 * The password, and the session it opened.
 *
 * The form is deliberately the slow kind: a password change is the one action on
 * this page that can lock an operator out of their own instance, so it takes
 * three fields and refuses to send anything it can tell is wrong locally. The
 * server is still the authority — a wrong current password comes back as an
 * error against the whole form rather than as a field complaint, because only
 * the server can tell you which of the two you got wrong.
 *
 * The session card is here rather than in General because it is the same
 * question: who may open this console, and for how long. A single-user instance
 * has exactly one session, so there is nothing to list and nothing to revoke
 * selectively — only this one to end.
 */
export function SecurityTab() {
  const auth = useAuthStatus();
  const change = useChangePassword();
  const logout = useLogout();

  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [problem, setProblem] = useState<Problem | null>(null);

  const set = <K extends FieldName>(key: K, value: Draft[K]): void => {
    setDraft((previous) => ({ ...previous, [key]: value }));
    setProblem(null);
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const found = validate(draft);
    if (found !== null) {
      setProblem(found);
      return;
    }
    change.mutate(
      { currentPassword: draft.currentPassword, newPassword: draft.newPassword },
      { onSuccess: () => setDraft(EMPTY) },
    );
  };

  const errorFor = (field: FieldName): string | undefined =>
    problem?.field === field ? problem.message : undefined;

  const session = auth.data;

  return (
    <div className="@container flex flex-col gap-4">
      <Card>
        <CardHeader
          title="Password"
          description="The single password that opens this console. Changing it ends nothing — the session you are in stays open."
        />

        <form
          className="mt-1 flex flex-col gap-4"
          onSubmit={(event) => {
            submit(event);
          }}
        >
          <Field label="Current password" required error={errorFor('currentPassword')}>
            {({ id, describedBy }) => (
              <Input
                id={id}
                type="password"
                autoComplete="current-password"
                value={draft.currentPassword}
                invalid={errorFor('currentPassword') !== undefined}
                disabled={change.isPending}
                {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
                onChange={(event) => {
                  set('currentPassword', event.target.value);
                }}
              />
            )}
          </Field>

          <Field
            label="New password"
            required
            hint={`${String(draft.newPassword.length)} / ${String(MIN_LENGTH)} minimum`}
            error={errorFor('newPassword')}
            description="At least eight characters. Length is the only rule — a passphrase beats a short scramble."
          >
            {({ id, describedBy }) => (
              <Input
                id={id}
                type="password"
                autoComplete="new-password"
                value={draft.newPassword}
                invalid={errorFor('newPassword') !== undefined}
                disabled={change.isPending}
                {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
                onChange={(event) => {
                  set('newPassword', event.target.value);
                }}
              />
            )}
          </Field>

          <Field label="Repeat new password" required error={errorFor('confirmPassword')}>
            {({ id, describedBy }) => (
              <Input
                id={id}
                type="password"
                autoComplete="new-password"
                value={draft.confirmPassword}
                invalid={errorFor('confirmPassword') !== undefined}
                disabled={change.isPending}
                {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
                onChange={(event) => {
                  set('confirmPassword', event.target.value);
                }}
              />
            )}
          </Field>

          {change.isError ? (
            <p role="alert" className="text-xs text-danger-text">
              {change.error.message}
            </p>
          ) : null}

          {change.isSuccess ? (
            <p role="status" aria-live="polite" className="text-xs text-success-text">
              Password changed. The session you are in is still open.
            </p>
          ) : null}

          <CardFooter className="mt-0">
            <Button
              type="submit"
              variant="primary"
              size="sm"
              loading={change.isPending}
              disabled={change.isPending}
            >
              Change password
            </Button>
          </CardFooter>
        </form>
      </Card>

      <Card>
        <CardHeader
          title="Session"
          description="This console is single-user: one password, one session, no accounts to manage."
          actions={
            <Button
              variant="secondary"
              size="sm"
              loading={logout.isPending}
              onClick={() => {
                logout.mutate();
              }}
            >
              <LogOut aria-hidden="true" className="size-3.5" />
              Log out
            </Button>
          }
        />

        <CardBody className="mt-1">
          {auth.isPending ? (
            <SkeletonText lines={2} />
          ) : auth.isError ? (
            <p role="alert" className="text-xs text-danger-text">
              Could not read the session: {auth.error.message}
            </p>
          ) : (
            <dl className="grid gap-3 @[520px]:grid-cols-3">
              <div className="flex flex-col gap-0.5">
                <dt className="text-[0.6875rem] uppercase tracking-wide text-text-subtle">State</dt>
                <dd>
                  {session?.authenticated === true ? (
                    <Badge
                      tone="success"
                      size="sm"
                      dot
                      icon={<ShieldCheck aria-hidden="true" className="size-3" />}
                    >
                      Signed in
                    </Badge>
                  ) : (
                    <Badge tone="warning" size="sm" dot>
                      Signed out
                    </Badge>
                  )}
                </dd>
              </div>
              <div className="flex flex-col gap-0.5">
                <dt className="text-[0.6875rem] uppercase tracking-wide text-text-subtle">Expires</dt>
                <dd className="text-xs text-text">
                  {session?.sessionExpiresAt == null ? '—' : formatDateTime(session.sessionExpiresAt)}
                </dd>
              </div>
              <div className="flex flex-col gap-0.5">
                <dt className="text-[0.6875rem] uppercase tracking-wide text-text-subtle">Time left</dt>
                <dd className="text-xs text-text">
                  {session?.sessionExpiresAt == null
                    ? 'No session open'
                    : formatRelative(session.sessionExpiresAt)}
                </dd>
              </div>
            </dl>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
