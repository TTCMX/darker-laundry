// Orders open on top of the screen you're on (a bottom sheet on the phone, a
// panel on the computer), like the original app: closing it leaves you where
// you were. Implemented with a "background location": the screen behind keeps
// rendering from `state.background` while the order routes render in a sheet.
// A direct link to /orders/… (or a reload) still shows the full page.

import { createContext, useCallback, useContext, useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate, type Location, type NavigateOptions } from "react-router-dom";
import { lockScroll } from "../ui/components";

export interface SheetState {
  background: Location;
  /** History entries pushed since the sheet opened: closing goes back that many. */
  depth: number;
}

export const sheetState = (location: Location): SheetState | null => {
  const s = location.state as Partial<SheetState> | null;
  return s?.background ? { background: s.background, depth: s.depth ?? 1 } : null;
};

const SheetContext = createContext<{ close: () => void } | null>(null);

/** Inside an order sheet: how to close it. */
export const useSheet = () => useContext(SheetContext);

/** Paths that open as a sheet. */
export const isSheetPath = (path: string) => /^\/orders\/(new|[0-9a-f-]{36})(\/edit)?\/?$/.test(path);

/**
 * Navigate keeping the sheet open: from the board to an order, from an order
 * to its editor… Anything else navigates normally (and the sheet goes away).
 */
export function useSheetNavigate() {
  const navigate = useNavigate();
  const location = useLocation();
  return useCallback(
    (to: string, opts: NavigateOptions = {}) => {
      const current = sheetState(location);
      // Not a sheet target, or on the full-page version of an order: plain navigation.
      if (!isSheetPath(to.split("?")[0] ?? to) || (!current && isSheetPath(location.pathname))) return navigate(to, opts);
      const state: SheetState = current
        ? { background: current.background, depth: current.depth + (opts.replace ? 0 : 1) }
        : { background: { ...location, state: null }, depth: 1 };
      navigate(to, { ...opts, state });
    },
    [navigate, location],
  );
}

/**
 * Plain <a href="/orders/…"> links anywhere in the app (lists, reports,
 * routes…) open the sheet too, without touching every screen.
 */
export function useSheetLinks() {
  const open = useSheetNavigate();
  const ref = useRef(open);
  ref.current = open;
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement | null)?.closest?.("a");
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin || !isSheetPath(url.pathname)) return;
      e.preventDefault();
      ref.current(url.pathname + url.search);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);
}

export function Sheet({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const state = sheetState(location);
  const depth = state?.depth ?? 1;
  const close = useCallback(() => navigate(-depth), [navigate, depth]);
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Let an inner dialog handle its own Escape first.
      if (e.key === "Escape" && !document.querySelector(".scrim .dialog")) closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    const unlock = lockScroll();
    return () => {
      document.removeEventListener("keydown", onKey);
      unlock();
    };
  }, []);

  return createPortal(
    <div className="sheet-scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="sheet" role="dialog" aria-modal="true">
        <span className="sheet-grip" aria-hidden />
        <SheetContext.Provider value={{ close }}>{children}</SheetContext.Provider>
      </div>
    </div>,
    document.body,
  );
}
