import { Card } from '@web/components/ui/Card.tsx';
import { AuthFrame } from '@web/shell/AuthFrame.tsx';

import { SetupForm } from './auth/SetupForm.tsx';

/**
 * The first run.
 *
 * Reached only while the instance reports `configured: false`, which the gate
 * enforces from both directions: a visitor who has never set the instance up is
 * sent here from anywhere in the console, and one who has is sent away from
 * here. So this page can assume there is no password yet and nothing to sign
 * into, and the form can be purely about the two questions worth asking.
 */
export function SetupPage() {
  return (
    <AuthFrame>
      <Card>
        <SetupForm />
      </Card>
    </AuthFrame>
  );
}
