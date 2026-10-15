import { Card } from '@web/components/ui/Card.tsx';
import { AuthFrame } from '@web/shell/AuthFrame.tsx';

import { LoginForm } from './auth/LoginForm.tsx';

/**
 * The way in.
 *
 * It owns no state and reads no record: `AuthGate` has already decided that this
 * is the right page to be on — the instance is configured and nobody is signed
 * in — so all that is left is the form. Where a successful sign-in lands is the
 * gate's decision too, which is why nothing here navigates.
 */
export function LoginPage() {
  return (
    <AuthFrame>
      <Card>
        <LoginForm />
      </Card>
    </AuthFrame>
  );
}
