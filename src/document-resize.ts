/** Settle a pane resize before restarting its expensive PDF raster/text render. */
export function createDocumentWidthScheduler(apply: (width: number) => void, settleMs = 120) {
  let committed: number | null = null;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const cancel = () => { clearTimeout(pending); pending = undefined; };
  return {
    update(width: number) {
      if (disposed) return;
      cancel();
      // Hidden panes preserve the last readable render and cancel queued reflows.
      if (!Number.isFinite(width) || width <= 0 || width === committed) return;
      if (committed === null) { committed = width; apply(width); return; }
      pending = setTimeout(() => { pending = undefined; committed = width; apply(width); }, settleMs);
    },
    dispose() { disposed = true; cancel(); },
  };
}
