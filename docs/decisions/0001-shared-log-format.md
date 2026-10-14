# ADR 0001: Shared log format

## Context

Node services and Cloudflare Workers emit lines consumed by the same logs store. Independent field names or level encodings can produce valid JSON that the consumer cannot ingest.

## Decision

The dependency-light SDK logging format owns numeric levels, the timestamp field, parsing and redaction. Node uses pino; Workers use their native console sink with the same structured fields. Self-contained workflow child bundles write the same fields directly to stderr, avoiding package-dependent transports inside isolated bootstraps. Emitters are tested through the shared parser.

## Consequences

Workers avoid Node transport dependencies, and every emitter change must preserve parser compatibility. Library diagnostics use the structured logger; console output at a logging sink is transport rather than an unstructured diagnostic.
