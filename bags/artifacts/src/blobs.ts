export const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
export interface ArtifactBlob {
  readonly sha256: string;
  readonly size: number;
}
export interface ArtifactBlobStore {
  stage(intentId: string, source: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<ArtifactBlob>;
  publish(intentId: string, blob: ArtifactBlob, signal?: AbortSignal): Promise<void>;
  discard(intentId: string): Promise<void>;
  stream(blob: ArtifactBlob, signal?: AbortSignal): Promise<AsyncIterable<Uint8Array>>;
}
