import { ConfigError } from "./env.js";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

/** Maps Postgres / PostgREST errors raised by our functions to HTTP errors. */
export function fromDbError(error: { code?: string; message: string } | null): HttpError | null {
  if (!error) return null;
  const status =
    error.code === "42501" ? 403 : error.code === "P0002" ? 404 : error.code === "23505" ? 409 : error.code === "22023" ? 422 : 500;
  return new HttpError(status, error.message, error.code);
}

/** Wraps a handler: consistent JSON errors, no stack traces to clients. */
export function handle(fn: (request: Request) => Promise<Response>) {
  return async (request: Request): Promise<Response> => {
    try {
      return await fn(request);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message, code: err.code }, err.status);
      if (err instanceof ConfigError) {
        console.error("[config]", err.message);
        return json({ error: "Server is not configured: " + err.message }, 503);
      }
      console.error("[api]", err);
      return json({ error: "Internal error" }, 500);
    }
  };
}
