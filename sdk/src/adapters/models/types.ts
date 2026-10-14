/**
 * The model catalog as the API serves it (`GET /api/v1/models`): per harness,
 * the models it offers and the model providers it reaches through catalogs.
 */
import { z } from "zod";

export const ModelInfoSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    /**
     * A measured caveat about the model, shown wherever someone picks one.
     * Carries the tool-calling warning for local Ollama models, which answer
     * in prose instead of calling tools under Barry's full system prompt — a
     * session "succeeds" having done nothing. The picker is where the choice
     * is made, so the caveat has to survive the contract to reach it.
     */
    note: z.string().optional(),
  })
  .strict();
/**
 * How a catalog-driven model provider is reached. Mirrors `ModelEndpoint` in
 * agents/models.ts field for field; the drift suite fails if they part.
 */
export const ModelEndpointSchema = z.object({
  wireProtocol: z.enum(["anthropic-protocol", "openai-protocol"]),
  baseUrl: z.string().nullable(),
  credentialEnvVar: z.string().nullable(),
  whenMissing: z.enum(["subscription-oauth", "unauthenticated", "placeholder"]),
  egressSandbox: z.boolean(),
  modelDiscovery: z.boolean().optional(),
  structuredOutput: z.enum(["native", "prompted"]).optional(),
}).strict();
/** A model provider an agent reaches through its catalog (z.ai, Ollama, ...). */
export const ModelProviderSchema = z.object({
  key: z.string(),
  label: z.string(),
  default: z.string().nullable(),
  endpoint: ModelEndpointSchema,
  models: z.array(ModelInfoSchema),
}).strict();
export const ProviderModelsSchema = z.object({
  label: z.string().optional(),
  default: z.string().nullable(),
  small: z.string().nullable(),
  models: z.array(ModelInfoSchema),
  /**
   * Set when provider discovery was attempted.
   *
   * `false` means the list was read live from the daemon. `true` means the
   * daemon was unreachable and this is the static fallback, which is a SHORTER
   * and possibly wrong list — so consumers must be able to say so rather than
   * presenting stale data as complete. Absent on static providers.
   */
  stale: z.boolean().optional(),
  source: z.enum(["live", "curated"]).optional(),
  /**
   * Catalog-driven providers the agent reaches per call (z.ai, Ollama). The
   * server has sent this since model providers became catalog entries rather
   * than agents of their own; the contract had not caught up, which is the
   * drift the hourly contract-drift job reported.
   */
  modelProviders: z.array(ModelProviderSchema).optional(),
}).strict();
export const ModelCatalogResponseSchema = z.object({
  providers: z.record(z.string(), ProviderModelsSchema),
}).strict();
