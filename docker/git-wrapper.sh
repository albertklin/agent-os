#!/bin/bash
# Git wrapper that restricts dangerous commands in sandboxed containers
# Real git binary is at /usr/bin/git.real

set -euo pipefail

# Commands that are safe - only affect current branch or are read-only
ALLOWED_COMMANDS="add|commit|status|diff|log|show|push|fetch|pull|rev-parse|config|ls-files|stash|remote|rev-list|describe|symbolic-ref|for-each-ref|cat-file|hash-object|write-tree|commit-tree|update-index|name-rev|merge-base|merge|rebase|cherry-pick|revert|restore|reset|am|apply|blame|shortlog|grep|bisect|notes|range-diff|whatchanged"

# Commands that can affect other branches or are dangerous
# checkout, switch - can switch branches
# branch - can delete/rename branches (listing is safe but hard to distinguish)
# tag - can delete tags
# clean - can delete untracked files (recoverable but annoying)
# gc, prune, reflog - maintenance commands that could cause issues

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
  # Extra check: block push --force and push --delete
  if [[ "$cmd" == "push" ]]; then
    for arg in "$@"; do
      if [[ "$arg" == "--force" || "$arg" == "-f" || "$arg" == "--force-with-lease" || "$arg" == "--delete" ]]; then
        echo "error: 'git push $arg' is not allowed in sandboxed sessions" >&2
        exit 1
      fi
    done
  fi
  exec /usr/bin/git.real "$@"
else
  echo "error: 'git $cmd' is not allowed in sandboxed sessions" >&2
  echo "allowed: add, commit, status, diff, log, push, fetch, pull, merge, rebase, cherry-pick, revert, reset, stash" >&2
  exit 1
fi
