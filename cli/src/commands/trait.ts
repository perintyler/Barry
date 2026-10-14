import { bounds, traits } from "@barry-rocks/identities-bag";
import { describeTraitRestrictions } from "../lib/trait-restrictions.js";

export async function traitListCommand(): Promise<void> {
  const allTraits = await traits.list();

  if (allTraits.length === 0) {
    console.log("No traits found. Run `barry setup` to seed the ones Barry ships with.");
    return;
  }

  // Fetched once and resolved locally: a trait's `boundNames` are names, and
  // the name alone does not say what is denied.
  const knownBounds = new Map((await bounds.list()).map((s) => [s.name!, s]));

  console.log("Traits:\n");
  for (const trait of allTraits) {
    console.log(`  ${trait.name}`);
    if (trait.description) {
      console.log(`    ${trait.description}`);
    }
    // Show every kind of grant, not just `tools`. Printing tools alone made
    // each namespace-based trait — which is most of them — read
    // "Tools: (none)" while it granted a whole bag's toolset, so the listing
    // said the opposite of the truth. Only claim a trait grants nothing when
    // all three are genuinely empty.
    const grants: string[] = [];
    if (trait.namespaces.length > 0) grants.push(`Namespaces: ${trait.namespaces.join(", ")}`);
    if (trait.tools.length > 0) grants.push(`Tools: ${trait.tools.join(", ")}`);
    if (trait.skills.length > 0) grants.push(`Skills: ${trait.skills.join(", ")}`);
    console.log(grants.length > 0 ? grants.map((g) => `    ${g}`).join("\n") : "    Grants: (none)");

    // Access and restrictions are the other half of what a trait does, and
    // both were invisible here. Without them a read-only trait printed exactly
    // like the unrestricted one it was meant to narrow — the listing could not
    // fail, because a scope silently absent looked the same as one applied.
    console.log(`    Access: ${trait.access}`);
    const restricts = describeTraitRestrictions(trait, knownBounds);
    if (restricts) console.log(`    Restricts: ${restricts}`);
    console.log("");
  }
}
