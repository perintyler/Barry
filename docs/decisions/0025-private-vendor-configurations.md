# ADR 0025: private generated vendor configurations

Status: accepted

## Context

Generated MCP configuration can contain bearer tokens or stdio credentials. Creation-only modes do not tighten reused files. Cursor and Codex used default creation modes, Antigravity protected only its MCP file, and OpenCode serialized configuration into its process environment.

## Decision

Use the SDK `writePrivateFile` helper for generated configs in caller-owned directories. Ensure 0700 immediate parents and 0600 new/reused regular files. Refuse final-file and immediate-parent symlinks, tighten permissions before truncating, and close descriptors on failure. OpenCode receives `OPENCODE_CONFIG` pointing to a private per-process runtime file; hosted and guest launches share this shape, while attaching clients receive neither config variable. Official OpenCode documentation describes the custom path and its precedence: https://opencode.ai/docs/config/.

## Consequences

Configuration secrets are absent from OpenCode's serialized environment; provider keys remain in the explicitly selected environment where the vendor reads them. Each launch owns its runtime file, preventing shared-session config overwrites. Project-config suppression remains enabled. This writer is for owned generated paths, not arbitrary caller files; it is not atomic and does not establish an adversarial filesystem boundary. Existing mode/credential behavior and actual pinned-build live checks still require verification. Codex stdio secret indirection remains a separate unfinished task.
