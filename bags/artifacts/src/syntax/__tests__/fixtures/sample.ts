/**
 * Self-contained sample TypeScript fixture for syntax highlighting tests
 */

export interface SampleBag {
  name: string;
  description: string;
  skills: readonly string[];
}

export function createSampleBag(name: string, description: string): SampleBag {
  const skills: string[] = ["search", "write"];
  return {
    name,
    description,
    skills,
  };
}
