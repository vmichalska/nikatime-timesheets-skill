# NikaTime Timesheets Skill

An agent skill for safely inspecting and filling NikaTime web timesheets from
Codex, Claude, or Cursor. It uses the same browser-managed authentication as the
NikaTime web app and defaults every write operation to a dry run.

## What it supports

- Inspect a month and discover the NikaTime API calls used by the web app.
- List the exact project IDs available to the signed-in user.
- Fill one day or multiple missing weekdays.
- Batch-fill dates from a JSON manifest.
- Replace a date with multiple entries for split work and time-off days.
- Verify exact dates, projects, hours, and notes after writes.
- Restore and verify previous records if a destructive replacement fails.

## Requirements

- macOS with Google Chrome installed.
- Node.js and npm.
- A NikaTime account authenticated through Slack.

The script can import NikaTime's encrypted `authCookie` from Chrome into a
dedicated automation profile. It never prints the cookie, Slack credentials, or
MFA secrets. If the session expires, it opens the Slack login flow and reuses the
renewed browser session.

## Install

Clone the repository to one canonical location, install the runtime dependency,
and link it into the clients you use:

```bash
git clone https://github.com/vmichalska/nikatime-timesheets-skill.git \
  "$HOME/.local/share/agent-skills/nikatime-timesheets"

cd "$HOME/.local/share/agent-skills/nikatime-timesheets/scripts"
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --omit=dev

mkdir -p "$HOME/.codex/skills" "$HOME/.claude/skills" "$HOME/.cursor/skills"
ln -s "$HOME/.local/share/agent-skills/nikatime-timesheets" \
  "$HOME/.codex/skills/nikatime-timesheets"
ln -s "$HOME/.local/share/agent-skills/nikatime-timesheets" \
  "$HOME/.claude/skills/nikatime-timesheets"
ln -s "$HOME/.local/share/agent-skills/nikatime-timesheets" \
  "$HOME/.cursor/skills/nikatime-timesheets"
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
