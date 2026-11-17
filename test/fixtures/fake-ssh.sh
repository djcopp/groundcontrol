#!/bin/sh
# Stands in for `ssh <target> <command>` in tests: drops the target and runs the command locally.
shift
exec sh -c "$*"
