/**
 * eslint-plugin-rutekit — local rules that mechanically enforce the design system.
 *
 * These rules are the difference between "the team agreed to use tokens" and
 * "tokens cannot be bypassed". They run only on `apps/web/src` (see eslint.config.js).
 *
 * Covered (RULESET R3.1–R3.4):
 *   no-hardcoded-color    — hex / rgb() / hsl() / oklch(), including arbitrary Tailwind values
 *   no-hardcoded-radius   — `rounded-[18px]` and friends
 *   no-hardcoded-duration — `duration-[250ms]`, `delay-[...]`, `ease-[...]`, `animate-[...]`
 *   no-inline-style       — `style={{ ... }}`, except objects holding only `--custom-props`
 *
 * Arbitrary values that reference a token are always allowed: `bg-[--color-surface-1]`,
 * `rounded-[--radius-card]`. The patterns below skip any bracket starting with `--`.
 */

const CLASS_HELPERS = new Set(['cn', 'clsx', 'cva', 'twMerge', 'twJoin', 'classNames']);

/** @type {Array<{ re: RegExp, what: string }>} */
const COLOR_PATTERNS = [
  { re: /#[0-9a-fA-F]{3,8}\b/, what: 'hex color' },
  { re: /\b(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\(/i, what: 'color function' },
  { re: /\[(?!--)[^\]]*(?:#|rgb|hsl|oklch)/i, what: 'arbitrary color value' },
];

/** @type {Array<{ re: RegExp, what: string }>} */
const RADIUS_PATTERNS = [
  { re: /rounded[a-z-]*-\[(?!--)[^\]]*(?:px|rem|em|%)/, what: 'arbitrary radius' },
];

/** @type {Array<{ re: RegExp, what: string }>} */
const DURATION_PATTERNS = [
  { re: /(?:duration|delay|ease|animate)-\[(?!--)[^\]]*\]/, what: 'arbitrary duration/easing' },
];

/**
 * Walk an expression tree, invoking `visit(node, text)` for every string-ish node.
 * Handles the shapes Tailwind class strings actually take in practice.
 */
function walk(node, visit) {
  if (!node) return;
  switch (node.type) {
    case 'Literal':
      if (typeof node.value === 'string') visit(node, node.value);
      return;
    case 'TemplateLiteral':
      for (const quasi of node.quasis) visit(quasi, quasi.value.cooked ?? quasi.value.raw);
      for (const expr of node.expressions) walk(expr, visit);
      return;
    case 'ConditionalExpression':
      walk(node.consequent, visit);
      walk(node.alternate, visit);
      return;
    case 'LogicalExpression':
      walk(node.left, visit);
      walk(node.right, visit);
      return;
    case 'BinaryExpression':
      if (node.operator === '+') {
        walk(node.left, visit);
        walk(node.right, visit);
      }
      return;
    case 'ArrayExpression':
      for (const element of node.elements) walk(element, visit);
      return;
    case 'CallExpression':
      for (const argument of node.arguments) walk(argument, visit);
      return;
    case 'TSAsExpression':
    case 'TSTypeAssertion':
    case 'TSNonNullExpression':
    case 'TSSatisfiesExpression':
      walk(node.expression, visit);
      return;
    default:
      return;
  }
}

/** @param {import('estree').CallExpression} node */
function classHelperName(node) {
  const callee = node.callee;
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
    return callee.property.name;
  }
  return null;
}

/**
 * Build a rule that inspects every Tailwind class string in JSX `className`
 * and in `cn()/clsx()/cva()` helper calls.
 */
function makeClassStringRule({ messageId, description, patterns }) {
  return {
    meta: {
      type: 'problem',
      docs: { description },
      schema: [],
      messages: {
        [messageId]: '{{what}} is not allowed — use a design-system token (RULESET R3).',
      },
    },
    create(context) {
      const reported = new WeakSet();

      function check(node, text) {
        if (reported.has(node)) return;
        for (const { re, what } of patterns) {
          if (re.test(text)) {
            reported.add(node);
            context.report({ node, messageId, data: { what } });
            return;
          }
        }
      }

      return {
        JSXAttribute(node) {
          const name = node.name;
          if (name.type !== 'JSXIdentifier') return;
          if (name.name !== 'className' && name.name !== 'class') return;
          const value = node.value;
          if (!value) return;
          if (value.type === 'Literal') check(value, String(value.value));
          else if (value.type === 'JSXExpressionContainer') walk(value.expression, check);
        },
        CallExpression(node) {
          const name = classHelperName(node);
          if (!name || !CLASS_HELPERS.has(name)) return;
          for (const argument of node.arguments) walk(argument, check);
        },
      };
    },
  };
}

/** A property key is allowed only when it is a literal CSS custom property name. */
function isCustomProperty(property) {
  if (property.type !== 'Property' || property.computed) return false;
  const key = property.key;
  return key.type === 'Literal' && typeof key.value === 'string' && key.value.startsWith('--');
}

/** `style={{ '--x': y } as CSSProperties}` is the idiomatic form — look through the cast. */
function unwrapExpression(node) {
  let current = node;
  while (
    current &&
    (current.type === 'TSAsExpression' ||
      current.type === 'TSSatisfiesExpression' ||
      current.type === 'TSNonNullExpression' ||
      current.type === 'TSTypeAssertion')
  ) {
    current = current.expression;
  }
  return current;
}

const noInlineStyle = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow inline `style` objects except pure CSS-custom-property maps (R3.4).',
    },
    schema: [],
    messages: {
      noInlineStyle:
        'Inline `style` is not allowed (R3.4). Use a class, or a CSS custom property when the value is genuinely dynamic.',
    },
  },
  create(context) {
    return {
      JSXAttribute(node) {
        if (node.name.type !== 'JSXIdentifier' || node.name.name !== 'style') return;
        const value = node.value;
        if (!value || value.type !== 'JSXExpressionContainer') return;
        const expression = value.expression;
        if (expression.type === 'JSXEmptyExpression') return;
        const object = unwrapExpression(expression);
        if (
          object.type === 'ObjectExpression' &&
          object.properties.length > 0 &&
          object.properties.every(isCustomProperty)
        ) {
          return;
        }
        context.report({ node, messageId: 'noInlineStyle' });
      },
    };
  },
};

export default {
  meta: {
    name: 'eslint-plugin-rutekit',
    version: '0.1.0',
  },
  rules: {
    'no-hardcoded-color': makeClassStringRule({
      messageId: 'noHardcodedColor',
      description: 'Disallow hardcoded colors in Tailwind class strings (R3.1).',
      patterns: COLOR_PATTERNS,
    }),
    'no-hardcoded-radius': makeClassStringRule({
      messageId: 'noHardcodedRadius',
      description: 'Disallow hardcoded radii in Tailwind class strings (R3.2).',
      patterns: RADIUS_PATTERNS,
    }),
    'no-hardcoded-duration': makeClassStringRule({
      messageId: 'noHardcodedDuration',
      description: 'Disallow hardcoded animation durations and easings (R3.3).',
      patterns: DURATION_PATTERNS,
    }),
    'no-inline-style': noInlineStyle,
  },
};
