import type { JobMethod } from '@contracts';

/**
 * Which providers the Automation page can drive, and how.
 *
 * Automation is not a capability every provider has, and it is not one shape
 * either: a batch can sign existing credentials in, register new accounts from
 * nothing, or post tokens that were issued elsewhere. Which of those a provider
 * supports is a fact about that provider's sign-in flow, so it is declared here
 * as a matrix rather than inferred from a flag on the catalog.
 *
 * The catalog's own `automation` capability stays as it is — it answers "can this
 * provider be automated at all", which is what the Provider Catalog's chips ask.
 * This table answers the narrower question the launcher needs: *which* methods,
 * and therefore *which fields*, a given provider offers. Keeping them apart means
 * the chips do not have to grow a method picker, and this list can be extended
 * without touching the catalog.
 *
 * Field order is the order they are asked for, which is the order the
 * consequences get worse: the wrong provider imports into the wrong place, and
 * the wrong method posts credentials to an endpoint that wanted tokens.
 */

/** A group of controls a method's form shows. */
export type AutomationField =
  | 'credentials'
  | 'tokens'
  | 'engine'
  | 'mode'
  | 'concurrency'
  | 'attempts'
  | 'proxy'
  | 'sms'
  | 'quantity';

export interface AutomationMethodSpec {
  readonly method: JobMethod;
  readonly fields: readonly AutomationField[];
  /** What the pasted blob holds, when the method takes one. */
  readonly payload: {
    readonly label: string;
    readonly hint: string;
    readonly placeholder: string;
  } | null;
}

export interface AutomationProviderSpec {
  /** The catalog id, so the picker and the jobs it creates agree. */
  readonly providerId: string;
  /** The name to show; the catalog's own, kept in step by hand. */
  readonly name: string;
  /** The catalog's icon slug, so the picker and the catalog look the same. */
  readonly icon: string;
  readonly methods: readonly AutomationMethodSpec[];
}

const CREDENTIALS: AutomationMethodSpec['payload'] = {
  label: 'Credentials',
  hint: 'One credential per line. Blank lines are ignored.',
  placeholder: 'name@example.com:password\nname2@example.com:password',
};

const TOKENS: AutomationMethodSpec['payload'] = {
  label: 'Tokens',
  hint: 'One token per line, or `accessToken:refreshToken` when the provider issues both.',
  placeholder: 'eyJhbGciOi...\neyJhbGciOi...:eyJyZWZyZXNo...',
};

/** The controls a browser-driven sign-in needs, and no more. */
const BROWSER_FIELDS: readonly AutomationField[] = [
  'credentials',
  'engine',
  'mode',
  'concurrency',
  'attempts',
  'proxy',
];

export const AUTOMATION_PROVIDERS: readonly AutomationProviderSpec[] = [
  {
    providerId: 'kiro',
    name: 'Kiro AI',
    icon: 'brain-circuit',
    methods: [{ method: 'bulk-login', fields: BROWSER_FIELDS, payload: CREDENTIALS }],
  },
  {
    providerId: 'qoder',
    name: 'Qoder',
    icon: 'droplet',
    methods: [{ method: 'bulk-login', fields: BROWSER_FIELDS, payload: CREDENTIALS }],
  },
  {
    providerId: 'codebuddy-intl',
    name: 'CodeBuddy',
    icon: 'bot',
    methods: [
      { method: 'bulk-login', fields: BROWSER_FIELDS, payload: CREDENTIALS },
      // Nothing to configure: the tokens *are* the import, and no browser runs.
      { method: 'bulk-token', fields: ['tokens'], payload: TOKENS },
    ],
  },
  {
    providerId: 'codebuddy-cn',
    name: 'CodeBuddy CN',
    icon: 'bot',
    methods: [
      {
        method: 'bulk-regist',
        // Registration has no credentials to paste — it creates them — so the
        // blob is replaced by how many to create and which key pays for the
        // numbers.
        fields: ['quantity', 'sms', 'engine', 'mode', 'concurrency', 'attempts', 'proxy'],
        payload: null,
      },
      { method: 'bulk-token', fields: ['tokens'], payload: TOKENS },
    ],
  },
];

export function automationProvider(providerId: string): AutomationProviderSpec | undefined {
  return AUTOMATION_PROVIDERS.find((entry) => entry.providerId === providerId);
}

/** The methods a provider offers, or none when it is not automatable. */
export function automationMethods(providerId: string): readonly AutomationMethodSpec[] {
  return automationProvider(providerId)?.methods ?? [];
}

/** One method of one provider, or undefined when the pair names nothing. */
export function automationMethod(
  providerId: string,
  method: JobMethod,
): AutomationMethodSpec | undefined {
  return automationMethods(providerId).find((entry) => entry.method === method);
}

/** Whether a method's form shows a given control. */
export function methodHasField(spec: AutomationMethodSpec, field: AutomationField): boolean {
  return spec.fields.includes(field);
}
