#!/usr/bin/env bash
# Refuses text that looks like a credential (ADR-0029). Everything the factory posts is public on a
# public repo, and GitHub masks secrets only in logs, not in comments or pull request bodies.
# Usage: guard-secrets.sh < text. Exits 1, printing only the kind of match, never the match.
set -euo pipefail

text=$(cat)
patterns=(
  'sk-ant-[A-Za-z0-9_-]{20,}'                # Anthropic API keys and OAuth tokens
  'gh[pousr]_[A-Za-z0-9]{30,}'               # GitHub tokens: personal, OAuth, user, server (App), refresh
  'github_pat_[A-Za-z0-9_]{30,}'             # GitHub fine-grained tokens
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'       # private keys
  'eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.' # JWTs (the runner's OIDC tokens)
)

for pattern in "${patterns[@]}"; do
  if grep -qE -- "$pattern" <<<"$text"; then
    echo "::error::Refusing to publish text that matches a credential pattern ($pattern)."
    exit 1
  fi
done
