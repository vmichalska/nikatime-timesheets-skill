# NikaTime Timesheets Skill

An agent skill for safely inspecting and filling NikaTime web timesheets from
Codex, Claude, or Cursor. It talks to NikaTime directly over HTTPS using a
cookie decrypted straight from Chrome, only falling back to a real browser
window when interactive login is actually needed, and defaults every write
operation to a dry run.

## What it supports

- Inspect a month and discover the NikaTime API calls used by the web app
  (the only command that always opens a real Chrome window, since that is
  how it observes live network traffic).
- List the exact project IDs available to the signed-in user.
- Fill one day or multiple missing weekdays.
- Batch-fill dates from a JSON manifest.
- Replace a date with multiple entries for split work and time-off days.
- Verify exact dates, projects, hours, and notes after writes.
- Restore and verify previous records if a destructive replacement fails.
- Optionally classify a month's weekdays from activity evidence (Glean,
  Slack, GitHub) when the user hasn't specified days or projects, always with
  confirmation first. See `references/monthly-workday-allocation.md`.

## Requirements

- macOS with Google Chrome installed.
- Node.js and npm.
- A NikaTime account authenticated through Slack.

The script decrypts NikaTime's encrypted `authCookie` straight from Chrome and
uses it directly over HTTPS for `projects`, `batch`, `replace`, and `fill` — no
browser involved as long as that session is valid. It never prints the cookie,
Slack credentials, or MFA secrets. If the session is missing or expired, it
opens a dedicated automation profile in a visible Chrome window, completes the
Slack login flow, and continues with the freshly renewed cookie.

## Install

Clone the repository straight into one client's skills folder, install the
runtime dependency, then symlink the other clients to that same clone:

```bash
git clone https://github.com/vmichalska/nikatime-timesheets-skill.git \
  "$HOME/.claude/skills/nikatime-timesheets"

cd "$HOME/.claude/skills/nikatime-timesheets/scripts"
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --omit=dev

mkdir -p "$HOME/.codex/skills" "$HOME/.cursor/skills"
ln -s "$HOME/.claude/skills/nikatime-timesheets" "$HOME/.codex/skills/nikatime-timesheets"
ln -s "$HOME/.claude/skills/nikatime-timesheets" "$HOME/.cursor/skills/nikatime-timesheets"
```

Restart or reload an already-open client so it discovers the skill.

## Invoke

In Codex:

```text
Use $nikatime-timesheets to preview my September entries.
```

In Claude or Cursor, ask the agent to use the `nikatime-timesheets` skill.

See [SKILL.md](SKILL.md) for the complete agent workflow and safety rules.

## Direct CLI examples

```bash
node scripts/nikatime.cjs inspect --month 2026-08
node scripts/nikatime.cjs projects --month 2026-08
node scripts/nikatime.cjs batch --month 2026-08 --file /absolute/path/entries.json
```

Commands are read-only unless `--apply` is supplied. Always inspect the dry-run
output before applying it.

## Disclaimer

This project automates NikaTime's web endpoints rather than a documented public
API. Endpoint behavior may change. Review dry runs and post-write verification,
especially after NikaTime web releases.
