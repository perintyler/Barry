/** Deliver instruction and action indexes through the prompt when a provider has no system-prompt channel. */

import { getDescribeAdapter } from "./agent-runtime.js";

export interface ProseSections {
  alwaysInstructions?: string;
  instructionsIndex?: string;
  actionsIndex?: string;
}

/**
 * Providers that ignore systemPrompt and need prose on the prompt itself.
 *
 * Read from the declared capability rather than a name list: this fallback
 * exists BECAUSE `systemPromptFormat` is "unsupported", so deriving it from
 * that field keeps the two from drifting. A provider added later that cannot
 * take a system prompt now gets the prefix automatically, instead of silently
 * receiving no instructions at all.
 */
export function needsPromptPrefix(provider: string): boolean {
  // An unknown provider does NOT get the prefix: sending it to something that
  // also honors systemPrompt would deliver the same content twice.
  return getDescribeAdapter()?.(provider)?.capabilities.systemPromptFormat === "unsupported";
}

/**
 * Build the prefix, or null when there is nothing to send.
 *
 * Always-on instructions lead: on the other providers they are system-prompt
 * guidance, so they must read as guidance here too rather than trailing the
 * indexes.
 */
export function buildProsePrefix(sections: ProseSections): string | null {
  const parts = [
    sections.alwaysInstructions,
    sections.instructionsIndex,
    sections.actionsIndex,
  ].filter((s): s is string => Boolean(s && s.trim()));

  return parts.length > 0 ? parts.join("\n\n") : null;
}

/**
 * Prefix a prompt with session prose, once per session.
 *
 * Sent once rather than every turn: it is context, not a per-turn instruction,
 * and repeating it would burn budget and read as nagging.
 */
export function applyProsePrefix(
  provider: string,
  sections: ProseSections,
  prompt: string,
  alreadySent: boolean,
): { prompt: string; sent: boolean } {
  if (!needsPromptPrefix(provider) || alreadySent) return { prompt, sent: alreadySent };

  const prefix = buildProsePrefix(sections);
  if (!prefix) return { prompt, sent: alreadySent };

  return { prompt: `${prefix}\n\n---\n\n${prompt}`, sent: true };
}
