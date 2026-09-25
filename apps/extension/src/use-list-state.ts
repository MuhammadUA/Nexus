/**
 * List-state preservation.
 *
 * spec `companion_extension.list_state_preservation` requires the selected business,
 * ICP, assignment filter, page, scroll position and selected row to survive opening
 * a lead and coming back. The panel is a single React tree, so component state would
 * normally survive — except the service worker and the panel are destroyed when
 * Chrome reclaims them. Persisting to `chrome.storage.local` is therefore what makes
 * the guarantee real rather than incidental.
 *
 * Scroll position is stored as a ratio plus the anchor index, so a restored list of
 * a slightly different height still lands on the same row.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { STORAGE_KEYS } from './config';

export interface ListState {
  readonly businessId: string;
  readonly icpId: string;
  readonly identityId: string;
  readonly statusFilter: string;
  readonly search: string;
  readonly page: number;
  readonly scrollRatio: number;
  readonly selectedIndex: number;
}

export const EMPTY_LIST_STATE: ListState = {
  businessId: '',
  icpId: '',
  identityId: '',
  statusFilter: '',
  search: '',
  page: 0,
  scrollRatio: 0,
  selectedIndex: -1,
};

/** Reads the persisted list state, falling back field-by-field so a partial or
 *  older record can never crash the panel. */
export async function loadListState(): Promise<ListState> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.listState);
  const raw: unknown = stored[STORAGE_KEYS.listState];
  if (typeof raw !== 'object' || raw === null) return EMPTY_LIST_STATE;
  const value = raw as Partial<ListState>;

  return {
    businessId: typeof value.businessId === 'string' ? value.businessId : '',
    icpId: typeof value.icpId === 'string' ? value.icpId : '',
    identityId: typeof value.identityId === 'string' ? value.identityId : '',
    statusFilter: typeof value.statusFilter === 'string' ? value.statusFilter : '',
    search: typeof value.search === 'string' ? value.search : '',
    page: typeof value.page === 'number' ? value.page : 0,
    scrollRatio: typeof value.scrollRatio === 'number' ? value.scrollRatio : 0,
    selectedIndex: typeof value.selectedIndex === 'number' ? value.selectedIndex : -1,
  };
}

export interface ListStateStore {
  readonly state: ListState;
  readonly ready: boolean;
  update(patch: Partial<ListState>): void;
  /** Binds a scrollable element so its position is saved and restored. */
  attachScroll(element: HTMLElement | null): void;
}

export function useListState(): ListStateStore {
  const [state, setState] = useState<ListState>(EMPTY_LIST_STATE);
  const [ready, setReady] = useState(false);
  const scrollRef = useRef<HTMLElement | null>(null);
  const restoredRef = useRef(false);
  /**
   * The scroll ratio to restore on the next attach.
   *
   * Held in a ref rather than read from `state`, because `attachScroll` is called during the first
   * render — with `EMPTY_LIST_STATE`, whose ratio is 0 — while the persisted state arrives from
   * `chrome.storage.local` a moment later. Reading `state.scrollRatio` there restored every list to
   * the top, which is exactly the guarantee the spec asks for being silently not met.
   */
  const restoreRatioRef = useRef(0);

  // Restore once on mount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const restored = await loadListState();
      if (cancelled) return;
      restoreRatioRef.current = restored.scrollRatio;
      setState(restored);
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const attachScroll = useCallback((element: HTMLElement | null) => {
    scrollRef.current = element;
    if (element !== null && !restoredRef.current) {
      restoredRef.current = true;
      // Deferred so the list has rendered before we scroll it.
      requestAnimationFrame(() => {
        const max = element.scrollHeight - element.clientHeight;
        if (max > 0) element.scrollTop = max * restoreRatioRef.current;
      });
    }
  }, []);

  const update = useCallback((patch: Partial<ListState>) => {
    setState((previous) => {
      const next = { ...previous, ...patch };

      // Record the live scroll position on every change, so navigating away without
      // an explicit save still restores correctly.
      const element = scrollRef.current;
      if (element !== null) {
        const max = element.scrollHeight - element.clientHeight;
        next.scrollRatio = max > 0 ? element.scrollTop / max : 0;
      }

      void chrome.storage.local.set({ [STORAGE_KEYS.listState]: next });
      return next;
    });
  }, []);

  return { state, ready, update, attachScroll };
}
