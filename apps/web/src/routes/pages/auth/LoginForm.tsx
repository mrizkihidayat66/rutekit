import { useState, type FormEvent } from 'react';

import { Button } from '@web/components/ui/Button.tsx';
import { Field } from '@web/components/ui/Field.tsx';
import { Input } from '@web/components/ui/Input.tsx';
import { useLogin } from '@web/hooks/use-system.ts';

import { AuthBrand } from './AuthBrand.tsx';
import { SESSION_NOTE } from './auth.ts';

/**
 * The way back in.
 *
 * Nothing here navigates on success. A completed login writes the auth record,
 * and the guest gate is watching that record — it is the one that knows where
 * the visitor was interrupted and therefore the only thing that should decide
 * where they land. A second navigation from this form would race it.
 *
 * The empty-password complaint is the form's own, because the browser would
 * otherwise let an empty field through and make the operator wait a round trip
 * to be told what they already knew. Everything else — including a password that
 * is simply wrong — is the server's to say.
 */
export function LoginForm() {
  const signIn = useLogin();
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (password === '') {
      setProblem('Enter the password for this instance.');
      return;
    }
    setProblem(null);
    signIn.mutate({ password });
  };

  return (
    <div className="flex flex-col gap-5">
      <AuthBrand />

      <div className="flex flex-col gap-1 text-center">
        <h1 className="font-head text-lg font-semibold tracking-tight text-text">Sign in</h1>
        <p className="text-xs text-text-muted">
          This console is single-user. Enter the password set when the instance was first run.
        </p>
      </div>

      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          submit(event);
        }}
      >
        <Field label="Password" required error={problem ?? undefined}>
          {({ id, describedBy }) => (
            <Input
              id={id}
              type="password"
              autoComplete="current-password"
              value={password}
              invalid={problem !== null}
              disabled={signIn.isPending}
              {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
              onChange={(event) => {
                setPassword(event.target.value);
                setProblem(null);
              }}
            />
          )}
        </Field>

        {signIn.isError ? (
          <p role="alert" className="text-xs text-danger-text">
            {signIn.error.message}
          </p>
        ) : null}

        <Button
          type="submit"
          variant="primary"
          className="w-full"
          loading={signIn.isPending}
          disabled={signIn.isPending}
        >
          Sign in
        </Button>
      </form>

      <p className="border-t border-border pt-3 text-center text-[0.6875rem] text-text-subtle">
        {SESSION_NOTE}
      </p>
    </div>
  );
}
