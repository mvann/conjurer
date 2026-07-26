import { Component, ReactNode } from "react";

// Keep a WebGL failure (no GPU, context loss) contained to the pane that
// owns the canvas instead of letting it unmount the whole page.
export class CanvasErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div
        style={{
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#8f96a8",
          fontSize: "13px",
          letterSpacing: "1.4px",
          textTransform: "uppercase",
          textAlign: "center",
          padding: "0 16px",
        }}
      >
        Render unavailable — {this.state.error.message}
      </div>
    );
  }
}
