/**
 * The API's deliberately-internal routes (SES-14).
 *
 * Most routes are declared through `serve(...).route(declaration)`, which puts
 * them in the generated OpenAPI contract and gives them a request/response
 * schema. A handful are registered with raw `router.get/post(...)`: they have no
 * zod schema and are absent from `GET /api/v1/openapi.json`. Some are internal
 * by design (the OTLP receiver at the vendor's paths, the delivery surfaces the
 * client reads verbatim, the signature-verified webhook); some are legacy.
 *
 * They are enumerated here, as full mounted paths, so there is ONE place that
 * says "this route is intentionally outside the published contract". The
 * accompanying `internal-routes.test.ts` walks every registered route and
 * fails if one is neither in the OpenAPI contract nor in this list — so a new
 * raw route cannot be added silently.
 *
 * `:param` segments match the Express declaration (`:id`, `:name`), not the
 * OpenAPI `{param}` form.
 */
export interface InternalRoute {
  method: "get" | "post" | "put" | "patch" | "delete";
  /** Full path as mounted, including `/api/v1` or `/v1`. */
  path: string;
}

export const INTERNAL_ROUTES: readonly InternalRoute[] = [
  // sessions.ts — not in OpenAPI (see report route table).
  { method: "get", path: "/api/v1/sessions/picker" },
  { method: "post", path: "/api/v1/sessions/invalidate-tools" },
  // session-lifecycle.ts — rulings (durable-turn approval surface) and attachments.
  { method: "post", path: "/api/v1/sessions/:id/rulings" },
  { method: "get", path: "/api/v1/sessions/:id/rulings" },
  { method: "post", path: "/api/v1/sessions/:id/attachments" },
  { method: "get", path: "/api/v1/sessions/:id/attachments" },
  { method: "get", path: "/api/v1/sessions/:id/attachments/:attachmentId" },
  // session-view.ts — HTML view, not a JSON contract.
  { method: "get", path: "/api/v1/sessions/:id/session-view" },
  // actions.ts — run cancellation.
  { method: "post", path: "/api/v1/actions/runs/:id/cancel" },
  // schedules.ts — the scheduler's own control surface.
  { method: "post", path: "/api/v1/schedules/once/:id/run" },
  { method: "get", path: "/api/v1/schedules/health" },
  { method: "get", path: "/api/v1/schedules/:bag/:name" },
  { method: "post", path: "/api/v1/schedules/:bag/:name/run" },
  { method: "post", path: "/api/v1/schedules/:bag/:name/pause" },
  { method: "post", path: "/api/v1/schedules/:bag/:name/resume" },
  { method: "post", path: "/api/v1/schedules" },
  { method: "delete", path: "/api/v1/schedules/runtime/:name" },
  // prompts.ts — delivery surfaces read verbatim by the client (snake_case body).
  { method: "post", path: "/api/v1/prompts/enqueue" },
  { method: "post", path: "/api/v1/prompts/wait" },
  { method: "post", path: "/api/v1/prompts/listeners" },
  { method: "post", path: "/api/v1/prompts/wake-budget" },
  // app.ts — bus signal.
  { method: "post", path: "/api/v1/identities/announce" },
  // webhooks.ts — signature-verified, pre-auth, mounted at /webhooks (not /api/v1).
  { method: "post", path: "/webhooks/mailgun/incoming" },
  // otlp.ts — the vendor's OTLP/HTTP paths under this API's root.
  { method: "post", path: "/v1/logs" },
  { method: "post", path: "/v1/traces" },
];
