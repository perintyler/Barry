# @barry-rocks/decision-typesafe

Install this provider independently with `npm install @barry-rocks/decision-typesafe`. It depends on the Barry SDK and its specific transport package.

The package exports compiled ESM and declarations for Node 26. Importing it does not authenticate or start a service. Pass an explicit endpoint and credential when creating a model; installing a provider does not grant identity permissions.

## Connection, environment and modes

Connects to the caller-supplied Typesafe System One endpoint. Barry binds the selected identity’s `TYPESAFE_API_KEY` to the endpoint. This is a model provider for structured decision requests, rather than a hosted, instrumented or guest session launcher. See its [source entry](src/index.ts) for the exported factory and endpoint contract.
