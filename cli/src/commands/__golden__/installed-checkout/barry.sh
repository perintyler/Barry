#!/bin/sh
# The barry CLI, installed by `barry setup` from <ROOT>.
# Pinned to the node that ran setup; rerun setup after moving the checkout.
export BARRY_DIR='<ROOT>'
exec <NODE> <ROOT>/cli/bin/barry.js "$@"
