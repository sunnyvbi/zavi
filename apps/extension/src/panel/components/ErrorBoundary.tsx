
import { Component, type ErrorInfo, type ReactNode } from "react";
import { CrashScreen } from "./CrashScreen";

type Props = { children: ReactNode; onError?: (error: unknown) => void };
type State = { error: unknown | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("[zavi:panel] render crashed", error, info?.componentStack);
    this.props.onError?.(error);
  }

  render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return (
      <CrashScreen
        error={this.state.error}
        onReload={() => {
          location.reload();
        }}
      />
    );
  }
}
