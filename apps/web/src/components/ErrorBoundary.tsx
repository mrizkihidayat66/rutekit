import { Component, type ErrorInfo, type ReactNode } from 'react';

import { StateView } from '@web/components/ui/StateView.tsx';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Shown instead of the default panel. Receives the error and a reset fn. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  /** Called for every caught error; the shell wires this to the log stream. */
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * A render error in one page must not take down the shell. Each route gets its
 * own boundary so the sidebar and topbar stay usable (A4).
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  private readonly reset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.fallback) return this.props.fallback(error, this.reset);

    return (
      <StateView
        kind="error"
        title="This view crashed"
        description={error.message}
        action={
          <button
            type="button"
            onClick={this.reset}
            className="h-9 rounded-control bg-accent px-3.5 text-sm font-medium text-accent-contrast transition duration-(--dur-micro) ease-out hover:opacity-90"
          >
            Try again
          </button>
        }
      />
    );
  }
}
