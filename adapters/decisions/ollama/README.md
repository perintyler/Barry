# @barry-rocks/decision-ollama

Install this provider independently with `npm install @barry-rocks/decision-ollama`. It depends on the Barry SDK and its specific transport package.

The package exports compiled ESM and declarations for Node 26. Importing it does not authenticate or start a service. Pass an explicit endpoint and credential when creating a model; installing a provider does not grant identity permissions.

## Connection, environment and modes

Connects to the caller-supplied Ollama HTTP endpoint. Endpoint and credential values are explicit inputs from the caller’s model binding; importing the package does not resolve an ambient account. This is a model provider for structured decision requests, rather than a hosted, instrumented or guest session launcher. See its [source entry](src/index.ts) for the exported factory and endpoint contract.
