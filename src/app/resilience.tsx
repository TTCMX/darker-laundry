// Keeps a deploy or an unexpected error from leaving a blank screen.
//
// Screens are loaded on demand as hashed files. After a new version is
// published, a tab that was already open asks for files that no longer
// exist: the app reloads once to pick up the new version. Any other render
// error shows a recoverable screen instead of an empty page.

import { Component, lazy, type ComponentType, type ErrorInfo, type ReactNode } from "react";

const RELOAD_KEY = "dlos.reloaded-at";

export const isChunkError = (e: unknown) =>
  e instanceof Error &&
  /dynamically imported module|Importing a module script failed|Failed to fetch|error loading dynamically|ChunkLoadError|MIME type/i.test(`${e.name} ${e.message}`);

/** Reload once (not in a loop) to get the newly deployed files. */
export function reloadForNewVersion(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
    if (Date.now() - last < 30_000) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    // No storage: still try once per page load.
    if ((window as unknown as { __dlosReloaded?: boolean }).__dlosReloaded) return false;
    (window as unknown as { __dlosReloaded?: boolean }).__dlosReloaded = true;
  }
  window.location.reload();
  return true;
}

/** React.lazy that survives a deploy: on a missing file, reload once. */
export function lazyPage<T extends ComponentType<object>>(load: () => Promise<{ default: T }>) {
  return lazy(() =>
    load().catch((err: unknown) => {
      if (isChunkError(err) && reloadForNewVersion()) return new Promise<{ default: T }>(() => {});
      throw err;
    }),
  );
}

// Vite reports failed preloads of shared files the same way.
if (typeof window !== "undefined") {
  window.addEventListener("vite:preloadError", (event) => {
    if (reloadForNewVersion()) event.preventDefault();
  });
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Unhandled render error", error, info.componentStack);
    if (isChunkError(error)) reloadForNewVersion();
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const update = isChunkError(error);
    return (
      <div className="center-page">
        <div className="empty" style={{ maxWidth: 420 }}>
          <span className="icon" aria-hidden>
            {update ? "system_update" : "error"}
          </span>
          <div className="title-m" style={{ color: "var(--on-surface)" }}>
            {update ? "Hay una versión nueva de la app" : "Algo salió mal en esta pantalla"}
          </div>
          <span>{update ? "Recarga para continuar." : "Tu información está a salvo. Recarga la página o vuelve al inicio."}</span>
          <div className="row" style={{ justifyContent: "center", marginTop: 8 }}>
            <button className="btn filled" onClick={() => window.location.reload()}>
              Recargar
            </button>
            <button
              className="btn text"
              onClick={() => {
                window.location.href = "/";
              }}
            >
              Ir al inicio
            </button>
          </div>
          {!update && (
            <details style={{ marginTop: 8, textAlign: "left", maxWidth: "100%" }}>
              <summary className="body-s">Detalle del error</summary>
              <pre className="body-s" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {error.message}
              </pre>
            </details>
          )}
        </div>
      </div>
    );
  }
}
