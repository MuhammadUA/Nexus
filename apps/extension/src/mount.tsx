/**
 * Side panel entry point.
 *
 * `sidepanel.tsx` exports the component; this mounts it. They are separate because a module
 * that both defines and mounts cannot be rendered anywhere else — the harness that verifies the
 * panel imports the component, and a mount at import time would break that.
 *
 * `static/sidepanel.html` provides `<div id="root">`, so this is the only thing that turns the
 * bundle into a running panel. Without it the file loads, exports a component, and renders
 * nothing at all — which is exactly what the panel did before this existed.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { SidePanel } from './sidepanel.js';

function mount(): void {
  const container = document.getElementById('root');
  if (container === null) {
    // Nothing to render into means the HTML shell and the bundle disagree; failing loudly
    // beats an empty panel with no explanation.
    throw new Error('side panel host element #root is missing');
  }

  createRoot(container).render(
    <StrictMode>
      <SidePanel />
    </StrictMode>,
  );
}

mount();
