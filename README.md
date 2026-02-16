# ats-review-responder

Auto-fixes ChatGPT Codex review comments on GitHub PRs using Claude Code.

Polls configured repos for open PRs, finds unresolved Codex bot comments, invokes Claude Code to apply the fix, commits, pushes, and resolves the review thread. Zero npm dependencies.

## How it works

1. Polls GitHub for open PRs on configured repos
2. Finds comments from `chatgpt-codex-connector[bot]` that are actionable (file-level, not approvals)
3. Clones/fetches the repo, checks out the PR branch
4. Builds a focused prompt from the comment (file, line, description, diff hunk)
5. Runs `claude -p --dangerously-skip-permissions` to edit the file
6. Commits the fix, pushes to the PR branch
7. Resolves the review thread via GitHub GraphQL API
8. Tracks processed comment IDs in `~/.ats-review-responder/state.json` to avoid duplicates
9. Sends Telegram notification with results

## Requirements

- Node.js 18+
- `gh` CLI (authenticated)
- `claude` CLI (Claude Code)
- Git with SSH access to configured repos

## Usage

```bash
# Continuous polling (every 60s by default)
node index.js

# Single poll, then exit
node index.js --once

# Filter to one repo
node index.js --once --repo difflabai/ats-project-runner
```

## Configuration

Edit `config.json`:

```json
{
  "repos": [
    { "owner": "difflabai", "repo": "ats-project-runner" },
    { "owner": "difflabai", "repo": "nanobazaar-song-seller" },
    { "owner": "difflabai", "repo": "ada-dispatch" }
  ],
  "poll_interval_ms": 60000,
  "claude_timeout_ms": 300000,
  "telegram_chat_id": "6644666619",
  "clone_base": "/tmp/ats-review-responder"
}
```

| Field | Description |
|-------|-------------|
| `repos` | GitHub repos to watch for Codex reviews |
| `poll_interval_ms` | Polling interval in ms (default: 60000) |
| `claude_timeout_ms` | Max time for Claude to fix a comment (default: 300000) |
| `telegram_chat_id` | Telegram chat ID for notifications (optional) |
| `clone_base` | Directory for repo clones (default: `/tmp/ats-review-responder`) |

## Running as a service

A systemd unit file is included:

```bash
cp ats-review-responder.service ~/.config/systemd/user/
systemctl --user enable ats-review-responder
systemctl --user start ats-review-responder
```

## State

Processed comments are tracked in `~/.ats-review-responder/state.json`. Delete this file to reprocess all comments.

## License

MIT
