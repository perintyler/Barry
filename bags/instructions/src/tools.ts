import { Barry } from "@barry-rocks/sdk";
/**
 * Instruction tools.
 *
 * An instruction is standing guidance — how this Barry does something, rather
 * than a procedure to run. Two shapes reach a session: always-on bodies, joined
 * into the system prompt, and on-demand entries, which cost only a description
 * line until something fetches them. These tools are how the on-demand half
 * gets read.
 *
 * They live in their own bag rather than in `actions` because they are not
 * about actions: an instruction is prose, an action is a procedure with a run
 * record. Sharing a namespace made `find_instructions` read as an actions tool.
 */


import { z } from "zod";
import { listAllInstructions, findInstruction } from "@barry-rocks/sdk/internal/instructions";
// The tool host supplies installed bags to the instruction catalog.
import { loadBagRegistrySnapshot } from "@barry-rocks/sdk/internal/bags";

export const searchInstructions = Barry.Tool({
  namespace: "instructions",
  access: "read",
  name: "search_instructions",
  description: `List or search reference instructions available to this session.

An instruction is standing guidance — how this Barry does something, rather than a procedure to run. Always-on instructions are already in your context; this surfaces the on-demand ones you can pull in with get_instructions. Omit the query to list everything.`,
  schema: {
    query: z
      .string()
      .optional()
      .describe("Filter by substring match on name or description. Omit to list everything."),
    limit: z.number().int().positive().max(200).optional().describe("Max results (default 50)."),
  },
  handler: async ({ query, limit }, context) => {
    // Scoped to the session's bags when known. Unscoped, this listed every
    // instruction on the machine — 37 from 22 bags where it was found, most
    // from bags the session never enabled — while the description promised
    // "available to this session" and said the always-on ones were "already in
    // your context". Both of those were computed from the session's bags. This
    // listing was not, because the option to scope it existed and nothing
    // passed it.
    //
    // Absent means unknown, not empty: an anonymous session and the CLI arrive
    // without context and keep seeing everything. Scoping those to nothing
    // would make one empty result mean both "your session has no bags" and
    // "no instructions are installed".
    const { bags } = await loadBagRegistrySnapshot();
    const all = await listAllInstructions(bags, context?.bagNames ? { bagNames: context.bagNames } : {});

    // A shadowed instruction is unreachable by bare name — listing it would
    // hand the agent a name that resolves to a different one.
    let found = all.filter((i) => !i.shadowed);

    if (query) {
      const q = query.toLowerCase();
      found = found.filter(
        (i) => i.name.toLowerCase().includes(q) || i.description.toLowerCase().includes(q),
      );
    }

    const capped = found.slice(0, limit ?? 50);
    return {
      count: capped.length,
      ...(found.length > capped.length ? { truncated: found.length - capped.length } : {}),
      instructions: capped.map((i) => ({
        name: i.name,
        source: i.source,
        qualifiedName: i.qualifiedName,
        description: i.description,
        mode: i.mode,
      })),
    };
  },
});

export const getInstructions = Barry.Tool({
  namespace: "instructions",
  access: "read",
  name: "get_instructions",
  description: `Read one instruction in full.

Returns the instruction's text. Use it when search_instructions — or a pointer in your context — shows guidance relevant to what you are doing.`,
  schema: {
    instruction: z
      .string()
      .min(1)
      .describe("Instruction name, or 'source:name' to disambiguate an overridden name."),
  },
  handler: async ({ instruction: ref }, context) => {
    // Resolve within the session's bags first, so a bare name means the same
    // instruction here as in search_instructions — shadowing is decided by the
    // set being searched, and resolving globally could hand back a different
    // bag's instruction of the same name.
    const scope = context?.bagNames ? { bagNames: context.bagNames } : {};
    const { bags } = await loadBagRegistrySnapshot();
    let found = await findInstruction(bags, ref, scope);

    // Then fall back to the global catalog. Deliberately not an error: a trait
    // can point at an instruction whose bag the identity does not list, and a
    // pointer the session was given in its own prompt must stay fetchable. The
    // scoped lookup decides WHICH instruction a name means; it does not decide
    // what may be read.
    if (!found && context?.bagNames) found = await findInstruction(bags, ref);

    if (!found) {
      throw new Error(
        `No instruction named "${ref}". Call search_instructions to see what is available.`,
      );
    }

    return {
      name: found.name,
      source: found.source,
      qualifiedName: found.qualifiedName,
      mode: found.mode,
      instructions: found.body,
    };
  },
});

export const publishInstructionTool = Barry.Tool({
  namespace: "instructions",
  access: "write",
  name: "publish_instruction",
  description: `Publish reference instructions and capture them as a durable deliverable artifact.

Saves guidance prose with an explicit name, description, and tags, returning the published reference and immutable artifact ID.`,
  schema: {
    name: z.string().min(1).describe("Instruction name, kebab-case (e.g. 'code-review-style')."),
    description: z.string().min(1).describe("Brief description of what this instruction covers."),
    content: z.string().min(1).describe("Markdown text containing the full instruction body."),
    source: z.string().optional().describe("Authoring source identifier (default 'adhoc')."),
    tags: z.array(z.string()).optional().describe("Optional searchable tags."),
  },
  handler: async ({ name, description, content, source, tags }) => {
    const { publishInstruction } = await import("./publish.js");
    const result = await publishInstruction({
      name,
      description,
      content,
      source,
      tags,
    });
    return {
      ok: true,
      name: result.name,
      qualifiedName: result.qualifiedName,
      revision: result.revision,
      artifactId: result.artifactId,
      contentHash: result.contentHash,
      publishedAt: result.publishedAt,
    };
  },
});

