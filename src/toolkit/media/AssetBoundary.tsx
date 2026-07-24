import { Component, type ReactNode } from "react";

/** Contains a failed suspense asset load (missing file, typo'd path): the subtree renders nothing instead of tearing down the canvas tree (the sceneDocSchema design law). Mount it keyed by the asset URL/src so a corrected path mounts a fresh boundary and retries the load. */
export class AssetBoundary extends Component<
  { label: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.warn(`[asset] "${this.props.label}" failed to load; rendering nothing:`, error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}
