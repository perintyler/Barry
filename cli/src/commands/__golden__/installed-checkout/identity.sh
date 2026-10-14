#!/usr/bin/env bash
# Barry identity shim — runs barry as `bux`.
# Installed by `barry identity create` / `barry alias`. Safe to delete.

export BARRY_IDENTITY="bux"
exec <NODE> <ROOT>/cli/bin/barry.js --identity-binding '{"id":7,"home":"<SCRATCH>/instance","instance":"<INSTANCE>"}' "$@"
