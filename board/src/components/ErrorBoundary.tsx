/** The page's last resort: an error while drawing shows what broke and a reload, instead of a blank board. */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { BrandMark } from './common';

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('Keelcrew board crashed', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="boot" role="alert">
        <BrandMark />
        <b>Something went wrong</b>
        <p>The board couldn’t show this page: {error.message || 'no details given'}</p>
        <button type="button" className="btn primary" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
