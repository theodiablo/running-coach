import { Component, type ReactNode } from "react";

// Catches stale-chunk load failures (a redeploy rotated the hashed chunk while
// the tab stayed open) so sign-out never white-screens — falls back to the
// statically-imported LoginScreen instead. Only chunk-load errors are
// swallowed; a genuine render bug is re-thrown to the app-wide ErrorBoundary.

function isChunkLoadError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return (
    /ChunkLoadError/i.test(msg) ||
    /dynamically imported module/i.test(msg) || // Vite / Chrome
    /Loading chunk [\w-]+ failed/i.test(msg) || // webpack-style
    /Importing a module script failed/i.test(msg) || // Safari
    /error loading dynamically imported module/i.test(msg) || // Firefox
    /Failed to fetch/i.test(msg)
  );
}

// `onError` fires once, in componentDidCatch, only for a swallowed *chunk-load*
// error — a place where side-effects are allowed. A modal gate (e.g. the lazy
// CoachChat) uses it to close itself and toast "check your connection", so a
// transient/stale-chunk failure degrades gracefully instead of white-screening,
// and unmounting the boundary resets it so the next open retries the import.
type Props = { fallback: ReactNode; children: ReactNode; onError?: (error: unknown) => void };
type State = { failed: boolean; error: Error | null };

export class ChunkLoadBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { failed: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { failed: true, error };
  }

  componentDidCatch(error: Error) {
    if (isChunkLoadError(error)) this.props.onError?.(error);
  }

  render() {
    if (this.state.failed) {
      // Re-throw non-chunk errors so the app-wide ErrorBoundary handles them
      // (a real render bug should not be hidden behind the fallback).
      if (!isChunkLoadError(this.state.error)) throw this.state.error;
      return this.props.fallback;
    }
    return this.props.children;
  }
}
