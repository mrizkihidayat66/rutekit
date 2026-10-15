import { StateView } from '@web/components/ui/StateView.tsx';
import { PageHeader } from '@web/shell/PageHeader.tsx';

export interface PagePlaceholderProps {
  title: string;
  description: string;
}

/**
 * A4 wires the routing graph before any page has content. Each route renders
 * this so the shell can be exercised end to end; FASE B replaces them one page
 * at a time, and GATE B fails while any of these remain.
 */
export function PagePlaceholder({ title, description }: PagePlaceholderProps) {
  return (
    <div className="flex min-h-full flex-col p-5">
      <PageHeader title={title} description={description} />
      <div className="flex flex-1 items-center justify-center rounded-card border border-dashed border-border">
        <StateView
          kind="empty"
          title="Scaffolded"
          description="This page is routed and framed. Its layout, data and states are built in FASE B."
        />
      </div>
    </div>
  );
}
