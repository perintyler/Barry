/**
 * Anthropic's completion models answering typed questions by prompting: the
 * Messages transport from the completion package, asked for one JSON object
 * and validated back into `Answer`s. Same endpoint, same request shape as a
 * completion — only the system prompt and temperature differ.
 */
import { type DecisionModel, answerViaJson, describeQuestions } from "@barry-rocks/sdk/adapters/models";
import type { Endpoint, VendorFactories } from "@barry-rocks/sdk/adapters/models";

import { send, textOf, usageOf } from "@barry-rocks/completion-anthropic/messages";

const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_TIMEOUT_MS = 60_000;

export function messagesDecisionModel(model: string, endpoint: Endpoint): DecisionModel {
  return {
    ref: `anthropic/${model}`,
    async decide(request) {
      const body = await send(endpoint, {
        system: describeQuestions(request.questions),
        prompt: typeof request.state === "string" ? request.state : JSON.stringify(request.state),
        model,
        maxTokens: DEFAULT_MAX_TOKENS,
        temperature: 0,
        timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
      return { answers: answerViaJson(request.questions, textOf(body)), servedModel: body.model ?? model, ...usageOf(body) };
    },
  };
}


export const DECISION_FACTORIES: VendorFactories = { decision: { anthropic: messagesDecisionModel } };
