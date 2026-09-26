import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { AuthProvider, TenantProvider } from "./lib/session";
import { ToastProvider } from "./ui/components";
import "@fontsource/roboto/latin-400.css";
import "@fontsource/roboto/latin-500.css";
import "@fontsource/roboto/latin-700.css";
import "@fontsource-variable/roboto-flex/index.css";
import "./ui/theme.css";

const queryClient = new QueryClient({
  // Any failed read surfaces as a snackbar instead of an empty screen.
  queryCache: new QueryCache({
    onError: (error) => window.dispatchEvent(new CustomEvent("dlos:error", { detail: error })),
  }),
  defaultOptions: {
    queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: true },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AuthProvider>
          <TenantProvider>
            <App />
          </TenantProvider>
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
