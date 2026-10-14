import type { RequestHandler, Response, Router } from "express";
import type { Route } from "../routes/route.js";

const registrations = new WeakMap<Router, Route[]>();
const OPAQUE_JSON_FIELDS = new Set(["input", "result", "metadata", "scope"]);

function camelCaseKey(key: string): string {
  return key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function camelCaseJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelCaseJson);
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return value;
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => {
    const publicKey = camelCaseKey(key);
    return [publicKey, OPAQUE_JSON_FIELDS.has(publicKey) ? nested : camelCaseJson(nested)];
  }));
}

export function camelResponse(body: unknown): unknown {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    if (record.ok === true) {
      const { ok: _ok, ...payload } = record;
      return camelCaseJson(payload);
    }
  }
  return camelCaseJson(body);
}

export function servedRoutes(router: Router): readonly Route[] {
  return [...(registrations.get(router) ?? [])];
}

export function serve(router: Router, base: string, options: { casing?: "camel" | "verbatim" } = {}) {
  const register = (declaration: Route, handlers: RequestHandler[], method = declaration.method) => {
    if (method !== declaration.method) throw new Error(`Method mismatch for ${declaration.operationId}`);
    const prefix = base.replace(/\/$/, "");
    if (declaration.path !== prefix && !declaration.path.startsWith(`${prefix}/`)) {
      throw new Error(`Route ${declaration.path} is outside base ${base}`);
    }
    const path = (declaration.path.slice(prefix.length) || "/").replace(/\{([^}]+)\}/g, ":$1");
    const check: RequestHandler = (req, res, next) => {
      const json = res.json.bind(res);
      res.json = ((body: unknown) => {
        const schema = declaration.responses[res.statusCode];
        if (schema) {
          const result = schema.safeParse(options.casing === "camel" ? camelResponse(body) : body);
          if (!result.success) {
            res.status(500).type("application/problem+json");
            return json({
              type: "about:blank", title: "Invalid route response", status: 500,
              detail: `${declaration.method.toUpperCase()} ${declaration.path}: ${result.error.message}`,
              issues: result.error.issues, instance: req.originalUrl,
            });
          }
        }
        return json(body);
      }) as Response["json"];
      next();
    };
    router[declaration.method](path, ...(process.env.VITEST ? [check] : []), ...handlers);
    const entries = registrations.get(router) ?? [];
    entries.push(declaration);
    registrations.set(router, entries);
  };
  return {
    route: (declaration: Route, ...handlers: RequestHandler[]) => register(declaration, handlers),
    get: (declaration: Route, ...handlers: RequestHandler[]) => register(declaration, handlers, "get"),
    post: (declaration: Route, ...handlers: RequestHandler[]) => register(declaration, handlers, "post"),
    put: (declaration: Route, ...handlers: RequestHandler[]) => register(declaration, handlers, "put"),
    patch: (declaration: Route, ...handlers: RequestHandler[]) => register(declaration, handlers, "patch"),
    delete: (declaration: Route, ...handlers: RequestHandler[]) => register(declaration, handlers, "delete"),
  };
}
