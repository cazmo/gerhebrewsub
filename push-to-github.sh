#!/bin/sh
# Auto-push current HEAD to GitHub.
# Called automatically on API server startup so every Replit checkpoint
# is reflected in the remote repo without manual intervention.
if [ -z "$GITHUB_TOKEN" ]; then
  echo "[gh-push] GITHUB_TOKEN not set — skipping"
  exit 0
fi

REMOTE="https://cazmo:${GITHUB_TOKEN}@github.com/cazmo/gerhebrewsub.git"
BRANCH="main"

git push --force "$REMOTE" "HEAD:${BRANCH}" \
  && echo "[gh-push] pushed HEAD to github.com/cazmo/gerhebrewsub ${BRANCH}" \
  || echo "[gh-push] push failed (non-fatal)"
