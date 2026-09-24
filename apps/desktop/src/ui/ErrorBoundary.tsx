import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Icon } from './Icon.js';

interface State {
  error: Error | null;
}

/**
 * Keeps a crash in one screen from blanking the whole window: shows what
 * went wrong with a Try again button instead. Give it a `key` per screen so
 * navigating away resets it.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Screen crashed', error, info.componentStack);
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="page">
        <div className="page-inner">
          <div
            className="panel panel-pad"
            style={{ display: 'flex', gap: 12, alignItems: 'center' }}
          >
            <Icon name="shield" size={18} />
            <div className="row-main" style={{ flexGrow: 1 }}>
              <span className="row-title">This screen ran into a problem</span>
              <span className="row-sub">{error.message || String(error)}</span>
            </div>
            <button type="button" onClick={() => this.setState({ error: null })}>
              <Icon name="refresh" size={13} /> Try again
            </button>
          </div>
        </div>
      </div>
    );
  }
}
