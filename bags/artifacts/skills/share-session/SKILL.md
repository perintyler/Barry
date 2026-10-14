---
name: share-session
description: Share the current conversation with a teammate, or load a teammate's shared conversation into context. Use when someone says to upload/save/share this conversation or session as an artifact, wants a link to send a colleague, or asks to fetch/pull/catch up on someone else's session or conversation from artifacts.
---

# Sharing a session with a teammate

Artifacts is a handoff channel between agent sessions. One person captures a
conversation and gets a link or share token; anyone else on the team can pull that conversation
into their own agent's context and carry on from there. No screen sharing, no
copy-pasting transcripts, no access to the other person's machine.

Two halves: **publish** and **pick up**.

---

## Publish — "share this conversation as an artifact"

1. **Write the conversation to markdown.** Capture what would let someone else
   continue: what was being attempted, what was discovered, decisions and the
   reasoning behind them, what is still open. Include file paths, commands, error
   messages, and URLs — a teammate cannot see your terminal.

   Favour a useful summary over a raw transcript. The goal is that another agent
   reading only this document can pick up the work.

2. **Capture it.** Call `artifact_create` with `title`, `mimeType: "text/markdown"`, `text`, and optional `tags`:

   ```
   artifact_create(
     title: "2026-10-06 Handoff: Barry Finalization",
     mimeType: "text/markdown",
     text: "<the markdown>",
     tags: ["handoff", "finalization"]
   )
   ```

   It lands in the active identity's immutable catalog automatically.

3. **Share it.** To generate a link for a teammate, call `artifact_share` with the returned artifact ID:

   ```
   artifact_share(
     action: "create",
     artifactId: "<artifact-id>",
     expiresInSeconds: 604800
   )
   ```

   Return the share link and token so the colleague can open or fetch it.

### Naming matters

Use `YYYY-MM-DD topic`: dated so recent sessions sort naturally, and topical so search finds it.

---

## Pick up — "fetch teammate's shared session"

1. **Search or read by ID.**
   Call `artifact_search(query: "<topic>")` or `artifact_read(id: "<artifact-id>")`.
   If a share link or token was provided, fetch the shared artifact directly.

2. **Read into context.**
   Inspect the returned content. The session state is now yours to build on.

3. **Summarize status.**
   Say what was picked up — a concise summary of where work left off and what is open.
