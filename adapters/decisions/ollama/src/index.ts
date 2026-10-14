/**
 * Ollama's generative models answering typed questions by prompting: the
 * daemon's `/api/chat` in JSON mode, validated back into `Answer`s. The
 * transport (`ollamaChat`, `usageOf`) is the completion package's — one
 * daemon, one transport, and two copies of its diagnostics would mislead
 * independently.
 */
import { type DecisionModel, answerViaJson, describeQuestions } from "@barry-rocks/sdk/adapters/models";
import type { Endpoint, VendorFactories } from "@barry-rocks/sdk/adapters/models";

import { ollamaChat, usageOf } from "@barry-rocks/completion-ollama/api";

const DEFAULT_TIMEOUT_MS = 120_000;

export function ollamaDecisionModel(model: string, endpoint: Endpoint): DecisionModel {
  return {
    ref: `ollama/${model}`,
    async decide(request) {
      const body = await ollamaChat(endpoint, {
        system: describeQuestions(request.questions),
        prompt: typeof request.state === "string" ? request.state : JSON.stringify(request.state),
        model,
        json: true,
        timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        temperature: 0.2,
      });
      return {
        answers: answerViaJson(request.questions, body.message?.content ?? ""),
        servedModel: body.model ?? model,
        ...usageOf(body),
      };
    },
  };
}


export const DECISION_FACTORIES: VendorFactories = { decision: { ollama: ollamaDecisionModel } };
