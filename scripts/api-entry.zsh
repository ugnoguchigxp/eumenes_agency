#!/bin/zsh
# Invoked with zsh -l: exported keys are inherited from ~/.zprofile, never copied to files.
exec bun --no-env-file "$@"
