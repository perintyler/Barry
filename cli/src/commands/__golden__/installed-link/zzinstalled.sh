#!/usr/bin/env bash
# Barry identity shim — runs barry as `zzinstalled`.
# Installed by `barry identity create` / `barry alias`. Safe to delete.

export BARRY_IDENTITY="zzinstalled"
export BARRY_NODE='<NODE>'
exec '<SCRATCH>/instance/app-support/current/bin/barry' --identity-binding '{"id":7,"home":"<SCRATCH>/instance","instance":"<INSTANCE>"}' "$@"
