# @barry-rocks/decision-von

Install this provider independently with `npm install @barry-rocks/decision-von`. It depends on the Barry SDK and its specific transport package.

The package exports compiled ESM and declarations for Node 26. Importing it does not authenticate or start a service. Pass an explicit endpoint and credential when creating a model; installing a provider does not grant identity permissions.

## Connection, environment and modes

Connects to the caller-supplied Von System One endpoint. The endpoint may carry the selected identity’s `VON_API_KEY`; the provider does not infer it from the ambient shell. This is a model provider for structured decision requests, rather than a hosted, instrumented or guest session launcher. See its [source entry](src/index.ts) for the exported factory and endpoint contract.
