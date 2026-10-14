#!/bin/sh
# The barry CLI, installed by `barry setup`: it runs what <SCRATCH>/instance/app-support/current points at.
exec '<SCRATCH>/instance/app-support/current/bin/barry' "$@"
