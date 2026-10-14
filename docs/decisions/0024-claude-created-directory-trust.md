# ADR 0024: Claude trust for explicitly created directories

Status: accepted

## Context

The launcher passed arbitrary repository cwd to a helper whose comment assumed Barry had created the directory. Claude maintains project trust in its shared global configuration, so launching alone must not imply directory approval. Official settings documentation distinguishes this state from a per-session settings file: https://code.claude.com/docs/en/settings.

## Decision

Require the directory-creating composition root to supply `options.barryCreatedDirectory`. The helper resolves both paths and pre-accepts only an exact canonical match. Missing or mismatched attestations leave the interactive trust decision with the user. Write the global configuration through a unique 0600 temporary file and atomic rename, preserving unrelated parsed fields.

## Consequences

Ordinary repository launches no longer pre-accept trust. The flag is an internal caller attestation, not a cryptographic proof of filesystem provenance. A root may set it only for a directory it created; no current CLI path attests its arbitrary cwd. Future worktree-to-TUI handoffs must pass the created path explicitly. Atomic rename prevents partial reads but does not serialize uncooperative vendor writes. Failed courtesy writes retain the interactive prompt.

## Historical source rationale

```text
/**
 * Pre-accepting claude's folder-trust dialog for a directory Barry itself
 * created and is about to launch `claude` in (a worktree, most often).
 *
 * The TUI gates on `projects["<realpath>"].hasTrustDialogAccepted` in
 * `~/.claude.json`, keyed by exact directory path (code.claude.com/docs/en
 * /permissions). A freshly created worktree has no entry, so every worktree
 * session re-asks a question the user already answered for the repo it came
 * from. `CLAUDE_CONFIG_DIR` redirection — which would let this live in a
 * disposable per-session file instead — is forbidden for this adapter
 * (credential.ts's `FORBIDDEN_CREDENTIAL_ENV`: it also breaks keychain
 * login), so this patches the user's one real global config file in place.
 *
 * That file is shared with every `claude` process on the machine and has no
 * lock of its own, so the write is kept atomic (temp file + rename, same
 * shape as `writeServiceRegistry`) and the read happens immediately before
 * it to keep the lost-update window as small as it can be — not zero, since
 * nothing here can take a lock the vendor CLI doesn't also take.
 *
 * Best-effort throughout: a failure here costs the user one dialog, not the
 * session.
 */
```
