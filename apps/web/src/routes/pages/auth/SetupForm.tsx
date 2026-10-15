import { useState, type FormEvent } from 'react';

import { Button } from '@web/components/ui/Button.tsx';
import { Field } from '@web/components/ui/Field.tsx';
import { Input } from '@web/components/ui/Input.tsx';
import { useSetupInstance } from '@web/hooks/use-system.ts';
import { cn } from '@web/lib/cn.ts';

import { AuthBrand } from './AuthBrand.tsx';
import { MIN_PASSWORD_LENGTH, PASSWORD_RULE, passwordProblem } from './auth.ts';

/**
 * The first run, in two steps.
 *
 * The contract takes both answers in one request, and so does this form — but
 * the wizard still asks in two steps, because they are two different questions.
 * A name is a decision about the instance; a password is a decision about who
 * can reach it, and it is the one that cannot be undone from inside the console.
 * Putting them on one screen would make the second look like a field of the
 * first.
 *
 * Nothing is sent until the last step, so a half-finished first run leaves no
 * trace: the instance either exists with both answers or does not exist at all.
 */

type Step = 'name' | 'password';

const STEPS: readonly { id: Step; label: string }[] = [
  { id: 'name', label: 'Name' },
  { id: 'password', label: 'Password' },
];

interface Problem {
  readonly field: 'instanceName' | 'password' | 'confirm';
  readonly message: string;
}

/** Prefilled rather than empty: "rutekit" is a fine answer, and it is the one the rail already shows. */
const DEFAULT_NAME = 'rutekit';

export function SetupForm() {
  const setup = useSetupInstance();
  const [step, setStep] = useState<Step>('name');
  const [instanceName, setInstanceName] = useState(DEFAULT_NAME);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [problem, setProblem] = useState<Problem | null>(null);

  const errorFor = (field: Problem['field']): string | undefined =>
    problem?.field === field ? problem.message : undefined;

  const clear = (field: Problem['field']): void => {
    setProblem((current) => (current?.field === field ? null : current));
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();

    if (step === 'name') {
      const trimmed = instanceName.trim();
      if (trimmed === '') {
        setProblem({ field: 'instanceName', message: 'Give this instance a name.' });
        return;
      }
      setProblem(null);
      setStep('password');
      return;
    }

    const complaint = passwordProblem(password);
    if (complaint !== null) {
      setProblem({ field: 'password', message: complaint });
      return;
    }
    if (password !== confirm) {
      setProblem({ field: 'confirm', message: 'The two passwords do not match.' });
      return;
    }
    setProblem(null);
    setup.mutate({ password, instanceName: instanceName.trim() });
  };

  return (
    <div className="flex flex-col gap-5">
      <AuthBrand />

      <ol className="flex items-center justify-center gap-2 text-[0.6875rem]">
        {STEPS.map((entry, index) => {
          const active = entry.id === step;
          return (
            <li
              key={entry.id}
              aria-current={active ? 'step' : undefined}
              className="flex items-center gap-2"
            >
              {index > 0 ? <span aria-hidden="true" className="h-px w-5 bg-border" /> : null}
              <span
                className={cn(
                  'flex size-5 items-center justify-center rounded-pill border text-[0.625rem] tabular-nums',
                  active
                    ? 'border-accent bg-accent text-accent-contrast'
                    : 'border-border bg-surface-2 text-text-subtle',
                )}
              >
                {index + 1}
              </span>
              <span className={active ? 'font-medium text-text' : 'text-text-subtle'}>
                {entry.label}
              </span>
            </li>
          );
        })}
      </ol>

      <div className="flex flex-col gap-1 text-center">
        <h1 className="font-head text-lg font-semibold tracking-tight text-text">
          {step === 'name' ? 'Set up this instance' : 'Choose a password'}
        </h1>
        <p className="text-xs text-text-muted">
          {step === 'name'
            ? 'Nothing has been configured yet. This takes two steps.'
            : 'This is the only password the console will ever ask for.'}
        </p>
      </div>

      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          submit(event);
        }}
      >
        {step === 'name' ? (
          <Field
            label="Instance name"
            required
            error={errorFor('instanceName')}
            description="What the console calls itself, in the rail and the browser tab. Changeable later in Settings."
          >
            {({ id, describedBy }) => (
              <Input
                id={id}
                value={instanceName}
                maxLength={64}
                autoComplete="off"
                spellCheck={false}
                invalid={errorFor('instanceName') !== undefined}
                disabled={setup.isPending}
                {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
                onChange={(event) => {
                  setInstanceName(event.target.value);
                  clear('instanceName');
                }}
              />
            )}
          </Field>
        ) : (
          <>
            <Field
              label="Password"
              required
              error={errorFor('password')}
              hint={`${String(password.length)} / ${String(MIN_PASSWORD_LENGTH)} minimum`}
              description={PASSWORD_RULE}
            >
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  invalid={errorFor('password') !== undefined}
                  disabled={setup.isPending}
                  {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    clear('password');
                  }}
                />
              )}
            </Field>

            <Field label="Repeat password" required error={errorFor('confirm')}>
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  invalid={errorFor('confirm') !== undefined}
                  disabled={setup.isPending}
                  {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
                  onChange={(event) => {
                    setConfirm(event.target.value);
                    clear('confirm');
                  }}
                />
              )}
            </Field>
          </>
        )}

        {setup.isError ? (
          <p role="alert" className="text-xs text-danger-text">
            {setup.error.message}
          </p>
        ) : null}

        <div className="flex items-center gap-2">
          {step === 'password' ? (
            <Button
              type="button"
              variant="secondary"
              disabled={setup.isPending}
              onClick={() => {
                setProblem(null);
                setStep('name');
              }}
            >
              Back
            </Button>
          ) : null}

          <Button
            type="submit"
            variant="primary"
            className="flex-1"
            loading={setup.isPending}
            disabled={setup.isPending}
          >
            {step === 'name' ? 'Continue' : 'Create this instance'}
          </Button>
        </div>
      </form>

      <p className="border-t border-border pt-3 text-center text-[0.6875rem] text-text-subtle">
        The password is stored hashed and cannot be read back — only replaced.
      </p>
    </div>
  );
}
