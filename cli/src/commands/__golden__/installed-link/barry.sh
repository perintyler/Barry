#!/bin/sh
# The barry CLI, installed by `barry setup`: it runs what <SCRATCH>/instance/app-support/current points at.
export BARRY_NODE='<NODE>'
exec '<SCRATCH>/instance/app-support/current/bin/barry' "$@"
