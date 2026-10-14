import {
  ArtifactError, ArtifactKindSchema,
  CreateShareInputSchema, UpdateArtifactMetadataSchema, UpdateShareInputSchema,
  type ArtifactKind, type ArtifactRecord, type ShareGrantRecord,
} from "../types.js";
import type { ArtifactCore } from "../core.js";
import { MAX_ARTIFACT_BYTES } from "../blobs.js";

export interface ArtifactHttpPrincipal {
  readonly actorId: number;
  readonly identityId: string;
  readonly credentialId: string;
  readonly scopes: readonly string[];
}

/** Artifact upload, which the core does not provide yet; without it the route answers 503. */
export interface ArtifactUpload {
  create?(
    input: { filename: string; mimeType: string; kind: ArtifactKind; title?: string; tags?: string[]; derivedFrom?: string; sessionId?: string; idempotencyKey?: string },
    content: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<ArtifactRecord>;
}
type RoutedCore = ArtifactCore & ArtifactUpload;

export interface ArtifactAuthenticator {
  authenticate(request: Request): Promise<ArtifactHttpPrincipal | null>;
}

export interface ArtifactHttpServerOptions {
  getCore: (identityId: string, principal: ArtifactHttpPrincipal) => RoutedCore | Promise<RoutedCore>;
  authenticator?: ArtifactAuthenticator;
  getShareByTokenHash?: (tokenHash: string, identityId: string) => Promise<{ identityId: string; share: ShareGrantRecord } | undefined>;
  getShareArtifactContent?: (identityId: string, artifactId: string, options?: { metadataOnly?: boolean; signal?: AbortSignal }) => Promise<{ record: ArtifactRecord; stream: AsyncIterable<Uint8Array> } | undefined>;
  verifyPassword?: (password: string, salt: string, expectedHash: string) => Promise<boolean>;
  hashToken?: (token: string) => Promise<string>;
  now?: () => string;
}

function errorResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function responseBody(stream: AsyncIterable<Uint8Array>, signal: AbortSignal): ReadableStream<Uint8Array> {
  const iterator = stream[Symbol.asyncIterator]();
  let onAbort: () => void;
  let closing: Promise<void> | undefined;
  const detach = () => signal.removeEventListener("abort", onAbort);
  const close = () => closing ??= (async () => {
    detach();
    await iterator.return?.();
  })();
  return new ReadableStream({
    start(controller) {
      onAbort = () => {
        void close().then(() => controller.error(signal.reason), error => controller.error(error));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    },
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) { detach(); controller.close(); }
        else controller.enqueue(next.value);
      } catch (error) {
        await close();
        controller.error(error);
      }
    },
    async cancel() { await close(); },
  });
}

export function createArtifactHttpHandler(options: ArtifactHttpServerOptions): (request: Request) => Promise<Response> {
  const now = options.now ?? (() => new Date().toISOString());

  return async function handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method;

    // Public /health endpoint
    if (pathname === "/health" && method === "GET") {
      return jsonResponse({ status: "ok", timestamp: now() });
    }

    // Public share route: /p/:identityId/:token and /p/:identityId/:token/raw
    const shareMatch = pathname.match(/^\/p\/([^/]+)\/([^/]+)(\/raw)?$/);
    if (shareMatch && (method === "GET" || method === "HEAD")) {
      const [, targetIdentityId, token, isRaw] = shareMatch;
      if (!options.getShareByTokenHash || !options.hashToken || !options.getShareArtifactContent) {
        return errorResponse(503, "unavailable", "Share service unavailable");
      }

      const tokenHash = await options.hashToken(token);
      const shareResult = await options.getShareByTokenHash(tokenHash, targetIdentityId);
      if (!shareResult || shareResult.identityId !== targetIdentityId) {
        return errorResponse(404, "not_found", "Share grant not found");
      }

      const { share } = shareResult;
      const currentTime = now();
      if (share.revoked || share.expiresAt <= currentTime) {
        return errorResponse(404, "not_found", "Share grant expired or revoked");
      }

      // Passwords in URLs leak through browser history and access logs.
      if (share.passwordHash && share.passwordSalt) {
        const providedPassword = request.headers.get("X-Artifact-Password");
        if (!providedPassword) {
          return errorResponse(401, "unauthorized", "Password required for this share");
        }
        if (!options.verifyPassword) {
          return errorResponse(503, "unavailable", "Password verifier unavailable");
        }
        const valid = await options.verifyPassword(providedPassword, share.passwordSalt, share.passwordHash);
        if (!valid) {
          return errorResponse(403, "forbidden", "Invalid share password");
        }
      }

      const content = await options.getShareArtifactContent(targetIdentityId, share.artifactId, {
        metadataOnly: !isRaw || method === "HEAD", signal: request.signal,
      });
      if (!content) {
        return errorResponse(404, "not_found", "Artifact not found");
      }

      const { record, stream } = content;

      if (!isRaw) {
        await stream[Symbol.asyncIterator]().return?.();
        // Return JSON preview metadata
        const preview = jsonResponse({
          artifact: {
            id: record.id, title: record.metadata.title, kind: record.content.kind,
            filename: record.content.filename, mimeType: record.content.mimeType,
            size: record.content.size, createdAt: record.content.createdAt,
          },
          share: { expiresAt: share.expiresAt },
        });
        return method === "HEAD" ? new Response(null, { status: preview.status, headers: preview.headers }) : preview;
      }

      // Return raw content stream with safe headers
      if (method === "HEAD") await stream[Symbol.asyncIterator]().return?.();

      const filename = encodeURIComponent(record.content.filename);
      return new Response(method === "HEAD" ? null : responseBody(stream, request.signal), {
        status: 200,
        headers: {
          "Content-Type": record.content.mimeType,
          "Content-Length": String(record.content.size),
          "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${filename}`,
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store",
        },
      });
    }

    // Authenticated API routes: /api/v1/identities/:identityId/artifacts...
    const apiMatch = pathname.match(/^\/api\/v1\/identities\/([^/]+)\/artifacts(?:\/(.*))?$/);
    if (!apiMatch) {
      return errorResponse(404, "not_found", "Route not found");
    }

    const [, targetIdentityId, subPathRaw] = apiMatch;
    const subPath = subPathRaw ? `/${subPathRaw}` : "";

    // Authenticate principal
    if (!options.authenticator) {
      return errorResponse(500, "internal_error", "No authenticator configured");
    }
    const principal = await options.authenticator.authenticate(request);
    if (!principal) {
      return errorResponse(401, "unauthorized", "Authentication required");
    }

    if (principal.identityId !== targetIdentityId) {
      return errorResponse(403, "forbidden", "Cannot access other identity artifacts");
    }

    const hasScope = (scope: string) => principal.scopes.includes(scope) || principal.scopes.includes("artifacts:*") || principal.scopes.includes("*");

    let core: RoutedCore;
    try {
      core = await options.getCore(targetIdentityId, principal);
    } catch {
      return errorResponse(500, "internal_error", "Failed to obtain artifact core");
    }

    try {
      // 1. POST /api/v1/identities/:identityId/artifacts -> Create artifact
      if (subPath === "" && method === "POST") {
        if (!hasScope("artifacts:write")) {
          return errorResponse(403, "forbidden", "artifacts:write scope required");
        }

        const idempotencyKey = request.headers.get("Idempotency-Key") || undefined;
        const contentType = request.headers.get("Content-Type") || "";

        let filename: string;
        let mimeType: string;
        let title: string | undefined;
        let tags: string[] | undefined;
        let derivedFrom: string | undefined;
        let sessionId: string | undefined;
        let contentStream: AsyncIterable<Uint8Array>;

        if (contentType.includes("application/json")) {
          const body = await request.json() as Record<string, unknown>;
          filename = String(body.filename || "");
          mimeType = String(body.mimeType || "text/plain");
          title = body.title ? String(body.title) : undefined;
          tags = Array.isArray(body.tags) ? body.tags.map(String) : undefined;
          derivedFrom = body.derivedFrom ? String(body.derivedFrom) : undefined;
          sessionId = body.sessionId ? String(body.sessionId) : undefined;
          const text = typeof body.text === "string" ? body.text : "";
          const encoded = new TextEncoder().encode(text);
          contentStream = (async function* () {
            yield encoded;
          })();
        } else {
          // Bounded stream / binary upload
          filename = request.headers.get("X-Artifact-Filename") || "artifact.bin";
          mimeType = contentType.split(";")[0].trim() || "application/octet-stream";
          title = request.headers.get("X-Artifact-Title") || undefined;
          const tagsHeader = request.headers.get("X-Artifact-Tags");
          tags = tagsHeader ? tagsHeader.split(",").map(s => s.trim()).filter(Boolean) : undefined;
          derivedFrom = request.headers.get("X-Artifact-Derived-From") || undefined;
          sessionId = request.headers.get("X-Artifact-Session-Id") || undefined;

          if (!request.body) {
            return errorResponse(400, "invalid_request", "Missing request body");
          }

          const reader = request.body.getReader();
          contentStream = (async function* () {
            let total = 0;
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              total += value.byteLength;
              if (total > MAX_ARTIFACT_BYTES) {
                throw new ArtifactError("too_large");
              }
              yield value;
            }
          })();
        }

        const kind = inferKind(filename, mimeType);
        if (!core.create) {
          return errorResponse(503, "unavailable", "Artifact upload unavailable");
        }
        const record = await core.create({
          filename,
          mimeType,
          kind,
          title,
          tags,
          derivedFrom,
          sessionId,
          idempotencyKey,
        }, contentStream, request.signal);

        return jsonResponse(record, 201);
      }

      // 2. GET /api/v1/identities/:identityId/artifacts -> List / Search artifacts
      if (subPath === "" && method === "GET") {
        if (!hasScope("artifacts:read")) {
          return errorResponse(403, "forbidden", "artifacts:read scope required");
        }

        const limitStr = url.searchParams.get("limit");
        const cursorCreatedAt = url.searchParams.get("cursor_created_at");
        const cursorId = url.searchParams.get("cursor_id");
        const rawKind = url.searchParams.get("kind");
        const parsedKind = rawKind ? ArtifactKindSchema.safeParse(rawKind) : undefined;
        if (parsedKind && !parsedKind.success) {
          return errorResponse(400, "invalid_request", `Unknown artifact kind: ${rawKind}`);
        }
        const kind = parsedKind?.data;
        const sessionId = url.searchParams.get("session_id") || undefined;
        const query = url.searchParams.get("query") || undefined;

        const cursor = cursorCreatedAt && cursorId ? { createdAt: cursorCreatedAt, id: cursorId } : undefined;
        const limit = limitStr ? parseInt(limitStr, 10) : 50;

        const result = await core.list({
          limit,
          cursor,
          kind,
          sessionId,
          query,
        }, request.signal);

        return jsonResponse(result, 200);
      }

      // 3. GET /api/v1/identities/:identityId/artifacts/:id -> Get artifact metadata
      const idMatch = subPath.match(/^\/([^/]+)$/);
      if (idMatch && method === "GET") {
        if (!hasScope("artifacts:read")) {
          return errorResponse(403, "forbidden", "artifacts:read scope required");
        }
        const record = await core.read(idMatch[1], request.signal);
        return jsonResponse(record, 200);
      }

      // 4. GET /api/v1/identities/:identityId/artifacts/:id/content -> Stream artifact content
      const contentMatch = subPath.match(/^\/([^/]+)\/content$/);
      if (contentMatch && (method === "GET" || method === "HEAD")) {
        if (!hasScope("artifacts:read")) {
          return errorResponse(403, "forbidden", "artifacts:read scope required");
        }
        const artifactId = contentMatch[1];
        if (!core.streamContent) {
          return errorResponse(503, "unavailable", "Streaming content unavailable");
        }

        const content = method === "HEAD"
          ? { record: await core.read(artifactId, request.signal), stream: undefined }
          : await core.streamContent(artifactId, request.signal);
        const { record, stream } = content;

        const filename = encodeURIComponent(record.content.filename);
        return new Response(stream ? responseBody(stream, request.signal) : null, {
          status: 200,
          headers: {
            "Content-Type": record.content.mimeType,
            "Content-Length": String(record.content.size),
            "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${filename}`,
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-store",
          },
        });
      }

      // 5. PATCH /api/v1/identities/:identityId/artifacts/:id/metadata -> Update metadata
      const metadataMatch = subPath.match(/^\/([^/]+)\/metadata$/);
      if (metadataMatch && method === "PATCH") {
        if (!hasScope("artifacts:write")) {
          return errorResponse(403, "forbidden", "artifacts:write scope required");
        }
        const artifactId = metadataMatch[1];
        const body = await request.json() as Record<string, unknown>;
        const updateInput = UpdateArtifactMetadataSchema.parse({
          id: artifactId,
          expectedRevision: body.expectedRevision,
          title: body.title,
          tags: body.tags,
        });
        const updated = await core.updateMetadata(updateInput, request.signal);
        return jsonResponse(updated, 200);
      }

      // 6. GET /api/v1/identities/:identityId/artifacts/:id/shares -> List shares
      const sharesListMatch = subPath.match(/^\/([^/]+)\/shares$/);
      if (sharesListMatch && method === "GET") {
        if (!hasScope("artifacts:read")) {
          return errorResponse(403, "forbidden", "artifacts:read scope required");
        }
        const artifactId = sharesListMatch[1];
        if (!core.listShares) {
          return errorResponse(503, "unavailable", "Shares not supported");
        }
        const shares = await core.listShares(artifactId, request.signal);
        return jsonResponse({ shares }, 200);
      }

      // 7. POST /api/v1/identities/:identityId/artifacts/:id/shares -> Create share
      if (sharesListMatch && method === "POST") {
        if (!hasScope("artifacts:share") || !hasScope("artifacts:read")) {
          return errorResponse(403, "forbidden", "artifacts:share and artifacts:read scopes required");
        }
        const artifactId = sharesListMatch[1];
        const body = await request.json() as Record<string, unknown>;
        const input = CreateShareInputSchema.parse({
          artifactId,
          expiresInSeconds: body.expiresInSeconds,
          password: body.password,
        });
        if (!core.createShare) {
          return errorResponse(503, "unavailable", "Share creation unavailable");
        }
        const share = await core.createShare(input, request.signal);
        const link = `/p/${targetIdentityId}/${share.token}`;
        return jsonResponse({ ...share, link }, 201);
      }

      // 8. PATCH /api/v1/identities/:identityId/artifacts/:id/shares/:shareId -> Update share
      const shareItemMatch = subPath.match(/^\/([^/]+)\/shares\/([^/]+)$/);
      if (shareItemMatch && method === "PATCH") {
        if (!hasScope("artifacts:share")) {
          return errorResponse(403, "forbidden", "artifacts:share scope required");
        }
        const [, , shareId] = shareItemMatch;
        const body = await request.json() as Record<string, unknown>;
        const input = UpdateShareInputSchema.parse({
          shareId,
          expectedRevision: body.expectedRevision,
          expiresInSeconds: body.expiresInSeconds,
          revoked: body.revoked,
          password: body.password,
        });
        if (!core.updateShare) {
          return errorResponse(503, "unavailable", "Share update unavailable");
        }
        const updated = await core.updateShare(input, request.signal);
        return jsonResponse(updated, 200);
      }

      // 9. DELETE /api/v1/identities/:identityId/artifacts/:id/shares/:shareId -> Revoke share
      if (shareItemMatch && method === "DELETE") {
        if (!hasScope("artifacts:share")) {
          return errorResponse(403, "forbidden", "artifacts:share scope required");
        }
        const [, , shareId] = shareItemMatch;
        if (!core.revokeShare) {
          return errorResponse(503, "unavailable", "Share revocation unavailable");
        }
        await core.revokeShare(shareId, request.signal);
        return jsonResponse({ revoked: true }, 200);
      }

      return errorResponse(404, "not_found", "Route not found");
    } catch (err: unknown) {
      if (err instanceof ArtifactError) {
        switch (err.code) {
          case "forbidden":
            return errorResponse(403, "forbidden", "Access denied");
          case "not_found":
            return errorResponse(404, "not_found", "Resource not found");
          case "conflict":
            return errorResponse(409, "conflict", "Revision conflict or duplicate resource");
          case "too_large":
            return errorResponse(413, "too_large", "Payload exceeds allowed maximum");
          case "unavailable":
            return errorResponse(503, "unavailable", "Operation unavailable");
          default:
            return errorResponse(500, "internal_error", err.message);
        }
      }
      return errorResponse(400, "invalid_request", (err instanceof Error && err.message) || "Invalid request");
    }
  };
}

function inferKind(filename: string, mimeType: string) {
  const ext = filename.split(".").pop()?.toLowerCase();
  if (mimeType === "text/markdown" || ext === "md") return "markdown";
  if (mimeType === "text/html" || ext === "html") return "html";
  if (mimeType === "image/svg+xml" || ext === "svg") return "svg";
  if (mimeType.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp"].includes(ext || "")) return "image";
  if (mimeType === "text/csv" || ext === "csv") return "csv";
  if (ext === "diff" || ext === "patch") return "diff";
  if (["js", "ts", "json", "py", "rs", "go", "c", "cpp", "h", "sh", "yaml", "yml"].includes(ext || "")) return "code";
  if (mimeType.startsWith("text/")) return "text";
  return "binary";
}
