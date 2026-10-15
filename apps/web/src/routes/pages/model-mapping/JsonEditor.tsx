import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import { useEffect, useRef } from 'react';

import { cn } from '@web/lib/cn.ts';

/**
 * Monaco, wired to the console's own design tokens.
 *
 * Two decisions worth stating.
 *
 * The editor is themed by reading the app's CSS custom properties at runtime
 * rather than by shipping a fixed palette. A second palette would be a second
 * place for the design system to drift, and it would not follow the theme
 * switch. Reading the tokens means the editor is the same colour as everything
 * around it, in both themes, by construction (RULESET R3.1).
 *
 * The module is loaded lazily by its consumer, because Monaco is by far the
 * largest thing in the console and only the JSON path needs it. Nothing on the
 * page imports this statically.
 *
 * Monaco owns its own DOM and its own keyboard handling; the wrapper only has to
 * give it a sized box, keep the value in step with React, and tear it down.
 */

/**
 * Workers have to be told where to come from; Vite bundles each as its own
 * chunk through the `?worker` suffix. JSON is the only language registered, so
 * anything else — the editor's own diff and formatting work — uses the default.
 */
(globalThis as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    return label === 'json' ? new jsonWorker() : new editorWorker();
  },
};

const THEME = 'rutekit';

/** A token's value, straight from the document. */
function cssVar(name: string): string {
  if (typeof document === 'undefined') return '';
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Monaco wants token colours as six hex digits with no `#`. */
function hexToken(name: string): string {
  return cssVar(name).replace(/^#/, '');
}

/**
 * Build the editor theme from the live tokens.
 *
 * `inherit: true` keeps Monaco's own tokenisation rules for everything this does
 * not name, so a token that ever fails to resolve degrades to the base theme
 * rather than to an unreadable colour.
 */
function buildTheme(): monaco.editor.IStandaloneThemeData {
  const dark = document.documentElement.dataset.theme === 'dark';
  return {
    base: dark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [
      { token: 'string.key.json', foreground: hexToken('--color-info') },
      { token: 'string.value.json', foreground: hexToken('--color-success') },
      { token: 'number', foreground: hexToken('--color-warning') },
      { token: 'keyword.json', foreground: hexToken('--color-danger') },
      { token: 'delimiter', foreground: hexToken('--color-text-muted') },
    ],
    colors: {
      'editor.background': cssVar('--color-surface-1'),
      'editor.foreground': cssVar('--color-text'),
      'editorLineNumber.foreground': cssVar('--color-text-subtle'),
      'editorLineNumber.activeForeground': cssVar('--color-text-muted'),
      'editorCursor.foreground': cssVar('--color-focus'),
      'editor.selectionBackground': cssVar('--color-border-strong'),
      'editor.inactiveSelectionBackground': cssVar('--color-border'),
      'editor.lineHighlightBackground': cssVar('--color-surface-2'),
      'editorIndentGuide.background1': cssVar('--color-border'),
      'editorWidget.background': cssVar('--color-surface-3'),
      'editorWidget.border': cssVar('--color-border'),
      'editorSuggestWidget.background': cssVar('--color-surface-3'),
      'editorSuggestWidget.border': cssVar('--color-border'),
      'scrollbarSlider.background': cssVar('--color-border'),
      'scrollbarSlider.hoverBackground': cssVar('--color-border-strong'),
    },
  };
}

export interface JsonEditorProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Names the editor for assistive technology; Monaco's own label is generic. */
  readonly label: string;
  readonly className?: string;
}

export function JsonEditor({ value, onChange, label, className }: JsonEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  // Everything the editor is created with is read through a ref, so it is built
  // exactly once. Depending on `value` would rebuild the editor on every
  // keystroke — throwing away the cursor, the selection and the undo stack, which
  // is the one thing a text editor must not do. A parent that wants a different
  // document remounts this component instead (see the `key` at its use site).
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const initialValue = useRef(value);
  const labelRef = useRef(label);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    monaco.editor.defineTheme(THEME, buildTheme());
    const editor = monaco.editor.create(host, {
      value: initialValue.current,
      language: 'json',
      theme: THEME,
      ariaLabel: labelRef.current,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontFamily: cssVar('--font-mono'),
      fontSize: 12,
      lineNumbersMinChars: 3,
      tabSize: 2,
      insertSpaces: true,
      renderLineHighlight: 'line',
      fixedOverflowWidgets: true,
      padding: { top: 8, bottom: 8 },
    });

    const subscription = editor.onDidChangeModelContent(() => {
      onChangeRef.current(editor.getValue());
    });

    // The theme switch is driven by an attribute on <html> from several places
    // — the toggle, the palette, the system listener — so it is observed rather
    // than hooked into each of them.
    const observer = new MutationObserver(() => {
      monaco.editor.defineTheme(THEME, buildTheme());
      monaco.editor.setTheme(THEME);
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    return () => {
      observer.disconnect();
      subscription.dispose();
      editor.dispose();
    };
  }, []);

  return (
    <div
      ref={hostRef}
      className={cn(
        'h-[22rem] w-full overflow-hidden rounded-control border border-border',
        className,
      )}
    />
  );
}
