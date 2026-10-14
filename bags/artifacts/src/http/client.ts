import {
  ArtifactError, ArtifactRecordSchema, type ArtifactCursor, type ArtifactList,
  type ArtifactRecord, type CreateShareInput, type ShareMetadata,
  type UpdateArtifactMetadata, type UpdateShareInput,
} from "../types.js";

export interface ArtifactHttpClientOptions {
  baseUrl: string;
  identityId: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
}

export class ArtifactHttpClient {
  readonly baseUrl: string;
  readonly identityId: string;
  private readonly token?: string;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(options: ArtifactHttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.identityId = options.identityId;
    this.token = options.token;
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.token && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${this.token}`);
    }
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      ...init,
      headers,
    });
    if (!response.ok) {
      let code: string = "internal_error";
      let message: string = response.statusText;
      try {
        const json = await response.json();
        if (json?.error?.code) code = json.error.code;
        if (json?.error?.message) message = json.error.message;
      } catch {
        // use fallback statusText
      }
      switch (response.status) {
        case 401:
        case 403:
          throw new ArtifactError("forbidden");
        case 404:
          throw new ArtifactError("not_found");
        case 409:
          throw new ArtifactError("conflict");
        case 413:
          throw new ArtifactError("too_large");
        case 503:
          throw new ArtifactError("unavailable");
        default:
          throw new Error(`Artifact HTTP error (${response.status} ${code}): ${message}`);
      }
    }
    return response;
  }

  async create(
    input: {
      filename: string;
      mimeType?: string;
      title?: string;
      tags?: readonly string[];
      derivedFrom?: string;
      sessionId?: string;
      idempotencyKey?: string;
      text?: string;
    },
    bytes?: AsyncIterable<Uint8Array> | Uint8Array,
    signal?: AbortSignal,
  ): Promise<ArtifactRecord> {
    const headers: Record<string, string> = {};
    if (input.idempotencyKey) {
      headers["Idempotency-Key"] = input.idempotencyKey;
    }

    let body: BodyInit;
    if (input.text !== undefined && !bytes) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(input);
    } else if (bytes) {
      headers["Content-Type"] = input.mimeType || "application/octet-stream";
      headers["X-Artifact-Filename"] = input.filename;
      if (input.title) headers["X-Artifact-Title"] = input.title;
      if (input.tags?.length) headers["X-Artifact-Tags"] = input.tags.join(",");
      if (input.derivedFrom) headers["X-Artifact-Derived-From"] = input.derivedFrom;
      if (input.sessionId) headers["X-Artifact-Session-Id"] = input.sessionId;

      if (bytes instanceof Uint8Array) {
        // fetch takes views of an ArrayBuffer only; a view of a shared buffer is copied.
        body = bytes.buffer instanceof ArrayBuffer ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new Uint8Array(bytes);
      } else {
        const stream = new ReadableStream({
          async start(controller) {
            try {
              for await (const chunk of bytes) {
                controller.enqueue(chunk);
              }
              controller.close();
            } catch (err) {
              controller.error(err);
            }
          },
        });
        body = stream;
      }
    } else {
      throw new Error("Either input.text or bytes must be provided");
    }

    // `duplex` is required to stream a request body and missing from RequestInit's type.
    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers,
      body,
      signal,
      duplex: "half",
    };
    const res = await this.request(`/api/v1/identities/${this.identityId}/artifacts`, init);

    const json = await res.json();
    return ArtifactRecordSchema.parse(json);
  }

  async read(id: string, signal?: AbortSignal): Promise<ArtifactRecord> {
    const res = await this.request(`/api/v1/identities/${this.identityId}/artifacts/${id}`, {
      method: "GET",
      signal,
    });
    return ArtifactRecordSchema.parse(await res.json());
  }

  async list(input?: ArtifactList, signal?: AbortSignal): Promise<{ items: readonly ArtifactRecord[]; nextCursor: ArtifactCursor | null }> {
    const params = new URLSearchParams();
    if (input?.limit) params.set("limit", String(input.limit));
    if (input?.cursor) {
      params.set("cursor_created_at", input.cursor.createdAt);
      params.set("cursor_id", input.cursor.id);
    }
    if (input?.kind) params.set("kind", input.kind);
    if (input?.sessionId) params.set("session_id", input.sessionId);
    if (input?.query) params.set("query", input.query);

    const qs = params.toString() ? `?${params.toString()}` : "";
    const res = await this.request(`/api/v1/identities/${this.identityId}/artifacts${qs}`, {
      method: "GET",
      signal,
    });
    return await res.json();
  }

  async updateMetadata(input: UpdateArtifactMetadata, signal?: AbortSignal): Promise<ArtifactRecord> {
    const res = await this.request(`/api/v1/identities/${this.identityId}/artifacts/${input.id}/metadata`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal,
    });
    return ArtifactRecordSchema.parse(await res.json());
  }

  async streamContent(id: string, signal?: AbortSignal): Promise<{ record: ArtifactRecord; stream: AsyncIterable<Uint8Array> }> {
    const res = await this.request(`/api/v1/identities/${this.identityId}/artifacts/${id}/content`, {
      method: "GET",
      signal,
    });
    const record = await this.read(id, signal);
    if (!res.body) {
      throw new ArtifactError("unavailable");
    }
    const reader = res.body.getReader();
    const stream = (async function* () {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        yield value;
      }
    })();
    return { record, stream };
  }

  async listShares(artifactId: string, signal?: AbortSignal): Promise<readonly ShareMetadata[]> {
    const res = await this.request(`/api/v1/identities/${this.identityId}/artifacts/${artifactId}/shares`, {
      method: "GET",
      signal,
    });
    const json = await res.json();
    return json.shares;
  }

  async createShare(input: CreateShareInput, signal?: AbortSignal): Promise<{ metadata: ShareMetadata; token: string; link: string }> {
    const res = await this.request(`/api/v1/identities/${this.identityId}/artifacts/${input.artifactId}/shares`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal,
    });
    return await res.json();
  }

  async updateShare(input: UpdateShareInput & { artifactId: string }, signal?: AbortSignal): Promise<ShareMetadata> {
    const { artifactId, ...update } = input;
    const res = await this.request(`/api/v1/identities/${this.identityId}/artifacts/${encodeURIComponent(artifactId)}/shares/${encodeURIComponent(input.shareId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update),
      signal,
    });
    return await res.json();
  }

  async revokeShare(artifactId: string, shareId: string, signal?: AbortSignal): Promise<void> {
    await this.request(`/api/v1/identities/${this.identityId}/artifacts/${artifactId}/shares/${shareId}`, {
      method: "DELETE",
      signal,
    });
  }
}
