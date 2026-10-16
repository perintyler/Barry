# ADR 0048: bundle CLI entries and load command actions on demand

Status: accepted

## Context

Every identity invocation paid for a TypeScript loader and unrelated command implementations. Version and help commands imported the launch graph before Commander could handle them.

## Decision

Build three ESM entries with esbuild: the system command, generated identity command and hook dispatcher. Keep command names, options, descriptions and help registration eager. Load actions when invoked, including worker and bag dispatch actions. Share one installed adapter registry between harness flags and model installation.

The executable wrappers select a bundle only when its recorded commit matches the checkout HEAD. Read Git files directly, including linked worktree and packed refs; releases without Git use the shipped bundle. `BARRY_BUNDLE=0` selects the TypeScript fallback. Enable Node's compile cache before loading either entry.

Preserve module-relative asset and subprocess locations with a build-time AST transform of actual `import.meta.url` and `import.meta.dirname` expressions. String literals containing generated code remain untouched. Keep chunks in the output directory so those relative URLs have a stable base. Bundle the runtime pin as JSON. Native modules, esbuild, tsx and adapter packages stay external. Register tsx inside the hook dispatcher only when a hook script needs TypeScript.

## Consequences

The package build finishes by bundling the CLI, including during setup and release builds before development dependencies are pruned. Release checks require all entries and metadata, verify the timing report identifies the bundled entry, and measure five version invocations. A median above 400 ms warns; above one second fails.

Version output does not require identity ownership lookup. Root identity help still validates the binding and resolves its current name, preserving rename and instance checks. Session-start help can render the generated command's scope without executing an action. Action paths retain instance and ownership validation.

Import checks cover source and bundle entries. They exclude tsx's own esbuild dependency from source-mode application checks. Relocated bundle smoke tests run both version entries without TypeScript dependencies. Launch parity fixtures remain unchanged.

Hosted session start registers the identity and session subjects first; guest execution expands to the full composition after mode selection. Reuse the ownership-validated binding row and resolve hosted model routing from declarations without constructing provider factories. Vendor catalogs reuse stamp-cached manifests, with the builtin parser retained when a fresh installation has no registry snapshot.
