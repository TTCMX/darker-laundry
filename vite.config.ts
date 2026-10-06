import react from "@vitejs/plugin-react";
import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { defineConfig, loadEnv, type Plugin, type ViteDevServer } from "vite";

/**
 * Serves the Vercel functions in /api during `npm run dev`, so the whole app
 * (UI + API) runs locally without the Vercel CLI. Production uses Vercel.
 */
function devApi(): Plugin {
  let server: ViteDevServer;
  return {
    name: "dlos-dev-api",
    apply: "serve",
    configureServer(s) {
      server = s;
      s.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (!url.pathname.startsWith("/api/")) return next();
        const file = resolve(__dirname, `.${url.pathname}.ts`);
        if (!existsSync(file) || url.pathname.includes("/_")) {
          res.statusCode = 404;
          return res.end(JSON.stringify({ error: "Not found" }));
        }
        try {
          const mod = (await server.ssrLoadModule(file)) as Record<string, (r: Request) => Promise<Response>>;
          const handler = mod[req.method ?? "GET"];
          if (!handler) {
            res.statusCode = 405;
            return res.end(JSON.stringify({ error: "Method not allowed" }));
          }
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const body = chunks.length ? Buffer.concat(chunks) : undefined;
          const request = new Request(`http://${req.headers.host}${req.url}`, {
            method: req.method,
            headers: req.headers as Record<string, string>,
            body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
          });
          const response = await handler(request);
          res.statusCode = response.status;
          response.headers.forEach((v, k) => res.setHeader(k, v));
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch (err) {
          server.ssrFixStacktrace(err as Error);
          console.error(err);
          res.statusCode = 500;
          res.end(JSON.stringify({ error: "Internal error" }));
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // Make server-side variables from .env.local available to the dev API.
  const env = loadEnv(mode, process.cwd(), "");
  for (const [k, v] of Object.entries(env)) if (!(k in process.env)) process.env[k] = v;
  return {
    plugins: [react(), devApi()],
    server: { port: 5173 },
    build: {
      chunkSizeWarningLimit: 900,
      rollupOptions: {
        output: {
          // Libraries in their own files: they don't change between deploys,
          // so phones keep them cached and only download the app's own code.
          manualChunks(id: string) {
            if (!id.includes("node_modules")) return undefined;
            if (id.includes("@supabase")) return "vendor-supabase";
            if (id.includes("@tanstack")) return "vendor-query";
            if (/node_modules\/(react|react-dom|react-router|react-router-dom|scheduler)\//.test(id)) return "vendor-react";
            return undefined;
          },
        },
      },
    },
  };
});
