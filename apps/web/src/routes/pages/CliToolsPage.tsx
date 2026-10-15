import { BookOpen, ExternalLink } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';

import { CLI_TOOLS, CLI_SURFACE_LABELS, CLI_SURFACE_PATHS, snippetsFor } from '@contracts';
import type { CliTarget, CliTool } from '@contracts';

import { Badge } from '@web/components/ui/Badge.tsx';
import { Button } from '@web/components/ui/Button.tsx';
import { Card, CardBody, CardHeader } from '@web/components/ui/Card.tsx';
import { Field } from '@web/components/ui/Field.tsx';
import { Input } from '@web/components/ui/Input.tsx';
import { useModelIds } from '@web/hooks/use-providers.ts';
import { PageHeader } from '@web/shell/PageHeader.tsx';

import { SnippetBlock, SurfaceBadge, UnverifiedNotice } from './cli-tools/SnippetBlock.tsx';
import {
  API_KEY_DESCRIPTION,
  BASE_URL_DESCRIPTION,
  MODEL_DESCRIPTION,
  defaultBaseUrl,
} from './cli-tools/cli-tools.ts';

/**
 * CLI Tools: what to put in a coding client's config to point it here.
 *
 * rutekit already speaks what these clients speak, so the whole page is three
 * values and a table of places to put them. The work is not in the generation —
 * it is in getting the three values right and being honest about the parts that
 * cannot be checked from a browser.
 *
 * **The output is text, and nothing is written anywhere.** Every reference
 * project this one learned from runs its console on the operator's own machine,
 * so it can detect installed clients and edit their config files. This console is
 * a web page against a server that may be on another host: it cannot see the
 * operator's home directory and has no business writing into it. So the page
 * generates and the operator pastes — a smaller feature than a file-writer, and a
 * better one, because a page that can rewrite `~/.codex/config.toml` is a page
 * whose compromise is a shell on the machine that holds every provider key.
 *
 * **The three values live in component state, not in the URL.** They are a draft
 * — a key's secret in particular is a thing to paste, use, and be done with —
 * and a query string is the wrong place for a secret: it lands in history, in
 * logs, and in whatever the operator pastes the link into next.
 *
 * **The base URL is the operator's to set.** The server cannot answer this one:
 * its bind address is `127.0.0.1:7331` by default, and a client on another
 * machine reading `127.0.0.1` means itself. See `cli-tools.ts` for why the
 * default is the browser's origin and why that is still only a default.
 */

/** The model a snippet starts with — routable anywhere, and cheap to try. */
const DEFAULT_MODEL = 'gpt-4o-mini';

function ToolCard({ tool, target }: { readonly tool: CliTool; readonly target: CliTarget }) {
  const snippets = useMemo(() => snippetsFor(tool, target), [tool, target]);

  return (
    <Card>
      <CardHeader
        title={tool.name}
        description={tool.description}
        actions={
          <SurfaceBadge
            label={CLI_SURFACE_LABELS[tool.surface]}
            path={CLI_SURFACE_PATHS[tool.surface]}
          />
        }
      />

      <CardBody className="flex flex-col gap-3">
        {tool.configLocation === null ? null : (
          <p className="text-[0.6875rem] text-text-subtle">
            Config lives at <span className="font-mono text-text-muted">{tool.configLocation}</span>
            .
          </p>
        )}

        {tool.formatVerified ? null : <UnverifiedNotice />}

        {snippets.length === 0 ? (
          <p role="alert" className="text-xs text-danger-text">
            No snippet is defined for this client yet.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {snippets.map((snippet) => (
              <SnippetBlock key={snippet.id} snippet={snippet} />
            ))}
          </div>
        )}

        {tool.docsUrl === null ? null : (
          <a
            href={tool.docsUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex w-fit items-center gap-1.5 text-[0.6875rem] text-text-muted underline-offset-2 hover:text-text hover:underline"
          >
            <BookOpen aria-hidden="true" className="size-3.5" />
            {tool.name} documentation
            <ExternalLink aria-hidden="true" className="size-3" />
          </a>
        )}
      </CardBody>
    </Card>
  );
}

export function CliToolsPage() {
  const [baseUrl, setBaseUrl] = useState(defaultBaseUrl);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(DEFAULT_MODEL);
  const { ids } = useModelIds();

  const target: CliTarget = { baseUrl, apiKey, model };

  return (
    <div className="flex min-h-full flex-col gap-5 p-5">
      <PageHeader
        title="CLI Tools"
        description="Point a coding agent or editor at this instance. rutekit already speaks the two dialects clients expect, so it is three values and the shape your client wants them in."
      />

      <Card>
        <CardHeader
          title="What to point at"
          description="Everything below is generated from these three values."
          actions={
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setBaseUrl(defaultBaseUrl());
              }}
            >
              Use this address
            </Button>
          }
        />

        <CardBody className="mt-1 grid gap-4 @[640px]:grid-cols-3">
          <Field label="Base URL" description={BASE_URL_DESCRIPTION}>
            {({ id, describedBy }) => (
              <Input
                id={id}
                value={baseUrl}
                spellCheck={false}
                autoComplete="off"
                inputSize="sm"
                placeholder="http://192.168.1.20:7331"
                {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
                onChange={(event) => {
                  setBaseUrl(event.target.value);
                }}
              />
            )}
          </Field>

          <Field label="API key" description={API_KEY_DESCRIPTION}>
            {({ id, describedBy }) => (
              <Input
                id={id}
                value={apiKey}
                spellCheck={false}
                autoComplete="off"
                inputSize="sm"
                placeholder="rk-…"
                {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
                onChange={(event) => {
                  setApiKey(event.target.value);
                }}
              />
            )}
          </Field>

          <Field label="Model" description={MODEL_DESCRIPTION}>
            {({ id, describedBy }) => (
              <>
                <Input
                  id={id}
                  value={model}
                  spellCheck={false}
                  autoComplete="off"
                  inputSize="sm"
                  list="cli-tool-models"
                  placeholder="gpt-4o-mini"
                  {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
                  onChange={(event) => {
                    setModel(event.target.value);
                  }}
                />
                {/* Suggestions rather than a closed list: an alias the operator
                    defined routes here too, and it is not in the catalog. */}
                <datalist id="cli-tool-models">
                  {ids.map((id) => (
                    <option key={id} value={id} />
                  ))}
                </datalist>
              </>
            )}
          </Field>
        </CardBody>

        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3 text-[0.6875rem] text-text-subtle">
          <Badge tone={apiKey === '' ? 'warning' : 'success'} size="sm">
            {apiKey === '' ? 'No key pasted' : 'Key pasted'}
          </Badge>
          <span>
            {apiKey === ''
              ? 'The snippets below are complete except for the key — read them, then paste a secret to copy a working one.'
              : 'The snippets below are ready to copy.'}
          </span>
          <Link
            to="/api-keys"
            className="ml-auto text-text-muted underline-offset-2 hover:text-text hover:underline"
          >
            Create a key
          </Link>
        </div>
      </Card>

      <div className="grid gap-4 @[880px]:grid-cols-2">
        {CLI_TOOLS.map((tool) => (
          <ToolCard key={tool.id} tool={tool} target={target} />
        ))}
      </div>

      <Card>
        <CardHeader title="How this works" />
        <CardBody className="flex flex-col gap-2 text-xs text-text-muted">
          <p>
            rutekit exposes the two dialects coding clients already speak —{' '}
            <span className="font-mono text-text">/v1/chat/completions</span> and{' '}
            <span className="font-mono text-text">/v1/messages</span> — and translates each to
            whatever the provider behind it wants. A client does not need to know which provider
            answers.
          </p>
          <p>
            Nothing on this page writes to your machine. Every snippet is text to copy, because this
            console is a web page and the machine running your coding client may be a different one.
          </p>
          <p>
            A client that is not listed here is almost certainly one of the two generic entries: the
            three values are the same, and only their spelling differs. Check that client&rsquo;s
            own documentation for the key names.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
