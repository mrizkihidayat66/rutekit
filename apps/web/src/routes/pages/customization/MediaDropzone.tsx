import { Link as LinkIcon, UploadCloud, X } from 'lucide-react';
import { useEffect, useRef, useState, type ChangeEvent, type DragEvent, type KeyboardEvent } from 'react';

import { Button } from '@web/components/ui/Button.tsx';
import { Field } from '@web/components/ui/Field.tsx';
import { Input } from '@web/components/ui/Input.tsx';
import { readFileAsDataUrl } from '@web/lib/appearance.ts';
import { cn } from '@web/lib/cn.ts';

/**
 * Two ways to name an asset: drop a file, or point at a URL.
 *
 * Both are needed. A file on the operator's disk is the common case and a URL
 * field is the only way to reference something already hosted — and until the
 * backend exists there is no upload endpoint, so a dropped file becomes a data
 * URL held in memory. That consequence is stated on the page rather than hidden,
 * because an operator who drops a wallpaper and reloads will otherwise think the
 * feature is broken.
 *
 * The component owns three pieces of state that belong to the act of choosing
 * rather than to the record: whether a drag is over it, what went wrong with the
 * last file, and the text in the URL box before it is committed.
 */

export interface MediaDropzoneProps {
  readonly label: string;
  readonly description: string;
  /** `accept` for the file input. */
  readonly accept: string;
  readonly formats: string;
  readonly maxBytes: number;
  readonly url: string | null;
  readonly placeholder: string;
  readonly disabled?: boolean;
  /** Rejects a file with a reason; `null` means it is usable. */
  readonly validate: (file: File) => string | null;
  readonly onChange: (url: string) => void;
  readonly onClear: () => void;
}

function formatLimit(bytes: number): string {
  return `${String(Math.round(bytes / (1024 * 1024)))} MB`;
}

export function MediaDropzone({
  label,
  description,
  accept,
  formats,
  maxBytes,
  url,
  placeholder,
  disabled = false,
  validate,
  onChange,
  onClear,
}: MediaDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A data URL is megabytes of base64 and belongs nowhere near a text box, so a
  // file-set asset leaves the URL field empty and says so instead.
  const fromFile = url !== null && url.startsWith('data:');
  const committed = url === null || fromFile ? '' : url;
  const [urlText, setUrlText] = useState(committed);

  useEffect(() => {
    setUrlText(committed);
  }, [committed]);

  const acceptFile = async (file: File): Promise<void> => {
    const problem = validate(file);
    if (problem !== null) {
      setError(problem);
      return;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      setError(null);
      onChange(dataUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The file could not be read.');
    }
  };

  const pick = (): void => {
    inputRef.current?.click();
  };

  const onInputChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    // Cleared so picking the same file twice still fires a change event.
    event.target.value = '';
    if (file === undefined) return;
    void acceptFile(file);
  };

  const onDrop = (event: DragEvent<HTMLButtonElement>): void => {
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    const file = event.dataTransfer.files[0];
    if (file === undefined) return;
    void acceptFile(file);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    // The button's own activation already covers Enter and Space; this only
    // stops a stray space from scrolling the page while the zone has focus.
    if (event.key === ' ') event.preventDefault();
  };

  const commitUrl = (): void => {
    const trimmed = urlText.trim();
    if (trimmed === '') {
      setUrlText(committed);
      return;
    }
    setError(null);
    onChange(trimmed);
  };

  return (
    <Field
      label={label}
      description={description}
      error={error}
      hint={url === null ? undefined : 'Set'}
    >
      <div className="flex flex-col gap-2">
        <button
          type="button"
          aria-label={`Upload ${label.toLowerCase()}`}
          disabled={disabled}
          onClick={pick}
          onKeyDown={onKeyDown}
          onDragEnter={() => {
            setDragging(true);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => {
            setDragging(false);
          }}
          onDrop={onDrop}
          className={cn(
            'flex w-full flex-col items-center gap-1.5 rounded-card border border-dashed px-4 py-5 text-center',
            'transition duration-(--dur-micro) ease-out',
            'disabled:cursor-not-allowed disabled:opacity-55',
            dragging
              ? 'border-border-strong bg-surface-3'
              : 'border-border bg-surface-2 hover:border-border-strong hover:bg-surface-3',
          )}
        >
          <UploadCloud aria-hidden="true" className="size-4 text-text-subtle" />
          <span className="text-xs text-text">
            Drop a file here, or <span className="font-medium underline">browse</span>
          </span>
          <span className="text-[0.6875rem] text-text-subtle">
            {formats} · up to {formatLimit(maxBytes)}
          </span>
        </button>

        <input
          ref={inputRef}
          type="file"
          accept={accept}
          className="hidden"
          onChange={onInputChange}
        />

        <div className="flex items-center gap-2">
          <Input
            inputSize="sm"
            value={urlText}
            placeholder={fromFile ? 'Set from a local file' : placeholder}
            aria-label={`${label} URL`}
            leading={<LinkIcon aria-hidden="true" />}
            disabled={disabled}
            className="min-w-0 flex-1"
            onChange={(event) => {
              setUrlText(event.target.value);
            }}
            onBlur={commitUrl}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commitUrl();
              }
            }}
          />
          {url === null ? null : (
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => {
                setError(null);
                onClear();
              }}
            >
              <X aria-hidden="true" className="size-3.5" />
              Clear
            </Button>
          )}
        </div>
      </div>
    </Field>
  );
}
