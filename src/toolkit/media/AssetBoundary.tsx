import { Component, type ReactNode } from "react";

/** Contains a failed suspense asset load (missing file, typo'd path): the subtree renders nothing instead of tearing down the canvas tree (the sceneDocSchema design law). Mount it keyed by the asset URL/src so a corrected path mounts a fresh boundary and retries the load. `resetKey` retries in place when it changes; `onError` hears each caught error. */
export class AssetBoundary extends Component<
  { label: string; children: ReactNode; onError?: (error: unknown) => void; resetKey?: unknown },
  { failed: boolean; resetKey?: unknown }
> {
  state = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: { resetKey?: unknown },
    state: { failed: boolean; resetKey?: unknown },
  ) {
    return props.resetKey === state.resetKey ? null : { failed: false, resetKey: props.resetKey };
  }

  componentDidCatch(error: unknown) {
    console.warn(`[asset] "${this.props.label}" failed to load; rendering nothing:`, error);
    this.props.onError?.(error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}
