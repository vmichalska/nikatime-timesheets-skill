# NikaTime Timesheets Skill

An agent skill for safely inspecting and filling NikaTime web timesheets from
Codex, Claude, or Cursor. It talks to NikaTime directly over HTTPS using a
private local session cache, recovers that session from a dedicated Chrome
profile without querying macOS Keychain, and opens a visible browser only when
interactive login is actually needed. Every write operation defaults to a dry
run. It also reads approved full-day and partial-day leave from Vacation Tracker
so time-off dates are not inferred from missing activity.

## What it supports

- Inspect a month and discover the NikaTime API calls used by the web app
  (the only command that always opens a real Chrome window, since that is
  how it observes live network traffic).
- List the exact project IDs available to the signed-in user.
- Show exactly what is already recorded for one date or a whole month, with
  project names resolved, before writing anything.
- Read approved Vacation Tracker leave for a month, including exact partial-day
  hours, through its first-party API without launching a browser in the normal
  path.
- Fill one day or multiple missing weekdays.
- Batch-fill dates from a JSON manifest (warns instead of silently no-oping
  when a date is already full under a different project than requested).
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
- A Vacation Tracker account signed in through the default Chrome profile when
  using the leave lookup.

The script uses NikaTime's `authCookie` directly over HTTPS for `projects`,
`show`, `batch`, `replace`, and `fill`. Like a CLI credential file, the cookie
is cached locally in `~/.local/share/nikatime-timesheets/session.json` with
owner-only (`0600`) permissions and is never printed. On a cache miss, a
dedicated reusable Chrome profile recovers the session headlessly and updates
the cache. If that profile also needs authentication, it opens visibly for
Slack login and then continues over direct HTTPS.

Normal commands never query Chrome Safe Storage, so they do not trigger the
recurring macOS password prompt. `--import-chrome` (or
`NIKATIME_IMPORT_CHROME=1`) explicitly imports the session from the default
Chrome profile and may prompt for the macOS password; it is a recovery option,
not the default. Set `NIKATIME_DISABLE_SESSION_CACHE=1` to keep the cookie only
in the dedicated browser profile, at the cost of a short headless browser launch
on each command. `NIKATIME_SESSION_CACHE` can select another cache path.

For Vacation Tracker, the script snapshots Chrome's local-storage database,
reads only its Cognito session keys, refreshes the token directly when needed,
and calls Vacation Tracker over HTTPS. Playwright is used only as a last-resort
interactive login fallback; tokens are never printed.

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
node scripts/nikatime.cjs show --month 2026-08 --date 2026-08-26
node scripts/nikatime.cjs vacations --month 2026-08
node scripts/nikatime.cjs batch --month 2026-08 --file /absolute/path/entries.json
```

Commands are read-only unless `--apply` is supplied. Always inspect the dry-run
output before applying it.

## Disclaimer

This project automates NikaTime's web endpoints and reads Vacation Tracker's web
GraphQL endpoint rather than relying on documented public APIs. Endpoint
behavior may change. Review dry runs and post-write verification, especially
after either service releases web-app changes.
