import { z } from "zod";

/** Process credential selections are distinct named bindings, never values. */
export const SecretNamesSchema = z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).superRefine((names, context) => {
  const seen = new Set<string>();
  names.forEach((name, index) => {
    if (seen.has(name)) context.addIssue({ code: "custom", path: [index], message: `duplicate secret name ${name}` });
    seen.add(name);
  });
});
