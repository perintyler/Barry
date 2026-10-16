/**
 * Merge bag capabilities into session config.
 *
 * Combines MCP servers, tool metadata, and skill dirs
 * from multiple bags into a unified session configuration.
 */

import type { Bag, BagMcpServer, BagToolMeta, BagService, ResolvedBagHook } from "./types.js";
import type { BagSchedule } from "../schedules/schedule-manifest.js";

export interface MergedBagConfig {
  mcpServers: Record<string, BagMcpServer>;
  tools: BagToolMeta[];
  skillsDirs: string[];
  /** Actions dirs from all bags, in registration order. */
  actionsDirs: string[];
  /** Instructions dirs from all bags, in registration order. */
  instructionsDirs: string[];
  /** Services from all bags, tagged with owning bag. */
  services: Array<BagService & { name: string; bag: string }>;
  /** Schedules from all bags, tagged with owning bag and the dir inline actions run in. */
  schedules: Array<BagSchedule & { name: string; bag: string; dir: string }>;
  /** Agent hooks from all bags, in registration order. */
  hooks: ResolvedBagHook[];
}

/** Merge MCP servers from multiple bags into a single config */
export function mergeBagMcpServers(
  bags: Bag[],
  existing: Record<string, BagMcpServer>,
): Record<string, BagMcpServer> {
  const merged = { ...existing };
  for (const bag of bags) {
    for (const [name, server] of Object.entries(bag.mcpServers)) {
      merged[name] = server;
    }
  }
  return merged;
}

/** Merge all capabilities from multiple bags */
export function mergeBags(bags: Bag[]): MergedBagConfig {
  const mcpServers: Record<string, BagMcpServer> = {};
  const tools: BagToolMeta[] = [];
  const skillsDirs: string[] = [];
  const actionsDirs: string[] = [];
  const instructionsDirs: string[] = [];
  const services: Array<BagService & { name: string; bag: string }> = [];
  const schedules: Array<BagSchedule & { name: string; bag: string; dir: string }> = [];
  const hooks: ResolvedBagHook[] = [];

  for (const bag of bags) {
    // MCP servers (dedup by name, last wins)
    for (const [name, server] of Object.entries(bag.mcpServers)) {
      mcpServers[name] = server;
    }

    tools.push(...bag.tools);

    skillsDirs.push(...bag.skillsDirs);
    actionsDirs.push(...bag.actionsDirs);
    instructionsDirs.push(...bag.instructionsDirs);
    hooks.push(...bag.hooks);

    // Services & schedules (append all, tagged with bag)
    for (const svc of bag.services) {
      services.push({ ...svc, bag: bag.name });
    }
    for (const schedule of bag.schedules ?? []) {
      schedules.push({ ...schedule, bag: bag.name });
    }
  }

  return {
    mcpServers,
    tools,
    skillsDirs,
    actionsDirs,
    instructionsDirs,
    services,
    schedules,
    hooks,
  };
}
