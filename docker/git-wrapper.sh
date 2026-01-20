#!/bin/bash
# Git wrapper that restricts dangerous commands in sandboxed containers
# Real git binary is at /usr/bin/git.real

set -euo pipefail

# Commands that are safe for normal development workflow
ALLOWED_COMMANDS="add|commit|status|diff|log|show|push|fetch|pull|rev-parse|config|ls-files|stash|remote|rev-list|describe|symbolic-ref|for-each-ref|cat-file|hash-object|write-tree|commit-tree|update-index|name-rev|merge-base"

# Get the git subcommand (first non-flag argument)
cmd=""
for arg in "$@"; do
  if [[ "$arg" != -* ]]; then
    cmd="$arg"
    break
  fi
done

if [[ -z "$cmd" ]]; then
  # No subcommand (e.g., `git --version`), allow it
  exec /usr/bin/git.real "$@"
fi

if [[ "$cmd" =~ ^($ALLOWED_COMMANDS)$ ]]; then
  exec /usr/bin/git.real "$@"
else
  echo "error: 'git $cmd' is not allowed in sandboxed sessions" >&2
  echo "allowed commands: add, commit, status, diff, log, show, push, fetch, pull, stash, remote" >&2
  exit 1
fi
