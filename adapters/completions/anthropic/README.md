# @barry-rocks/completion-anthropic

Install this provider independently with `npm install @barry-rocks/completion-anthropic`. It depends on the Barry SDK.

The package exports compiled ESM and declarations for Node 26. Importing it does not authenticate or start a service. Pass an explicit endpoint and credential when creating a model; installing a provider does not grant identity permissions.

## Connection, environment and modes

Connects to the caller-supplied Anthropic-compatible Messages endpoint. The selected endpoint supplies its API key; Barry resolves the identity’s `ANTHROPIC_API_KEY` when binding this provider. This is a model provider for completion requests, rather than a hosted, instrumented or guest session launcher. See its [source entry](src/index.ts) for the exported factory and endpoint contract.
