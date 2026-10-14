# ADR 0028: Codex custom endpoint configuration

Status: implemented on Step 15; full gates and backend turn acceptance pending.

## Evidence

Pinned Codex 0.160.1 rejects generated configuration using `wire_api = "chat"`.
It also rejects a custom provider block named `openai`, because built-in provider
IDs are reserved. Both failures were reproduced through the real app-server before
changing the adapter; synthetic credentials and a closed loopback endpoint were used.

The previous implementation assumed an OpenAI-compatible endpoint meant Chat
Completions. That assumption is incompatible with the pinned vendor's current
configuration format. The previous provider-key derivation also reused the model
vendor name directly, which collided with a reserved ID.

## Decision

Generated custom provider blocks use Responses and a `barry-endpoint-` namespace.
Credential variable names and the model component remain unchanged. An explicitly
chat-only request to the provider-block helper is refused rather than emitted as
configuration the vendor cannot load.

Custom URLs must implement Responses; the adapter does not translate Chat
Completions or assert that any particular backend implements Responses. Its README
and capability comment state that restriction. The opt-in stdio live test now
uses the direct custom-endpoint path, without a CLI configuration override.

## Verification and remaining scope

Three negative/changed expectations failed before implementation. Eighteen focused
assertions now pass, including pinned vendor configuration loading and a successful
MCP initialization through that configuration. Types and focused lint are checked
separately. This establishes loading, not a real model turn against a backend.

The broader SDK model-selection seam must distinguish actual Responses support
from generic OpenAI protocol compatibility, or provide a verified translation.
That cross-lane integration belongs to the final seam audit; it must not advertise
chat-only routes as compatible. Paid-provider acceptance and full gates remain open.
