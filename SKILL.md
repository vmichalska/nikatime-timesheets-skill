---
name: nikatime-timesheets
description: Inspect, preview, create, batch-fill, and safely replace NikaTime web timesheet entries using browser-managed authentication. Use when the user asks to read or fill NikaTime dates, projects, hours, notes, vacation, or other time off; do not use for unrelated time trackers.
---

# NikaTime Timesheets

Use `scripts/nikatime.cjs` for deterministic NikaTime reads and writes. It drives
the web API through Chrome so NikaTime's `Secure`, `HttpOnly` `authCookie` stays
browser-managed.

## Safety and authorization

- Never ask the user to paste or reveal `authCookie`, Slack credentials, or MFA.
- Read operations (`inspect`, `projects`, and commands without `--apply`) are safe
  preparation. Run a dry run before every mutation and show or check the exact
  dates, project IDs, hours, and notes.
- Do not add `--apply` unless the user explicitly asked to submit those entries.
  A prior request to inspect, research, or prepare a script is not authorization.
- Resolve material ambiguity before writing, especially partial-day hours and the
  time-off category. When project names are similar, use `projects` and match the
  exact name; ask the user if more than one candidate remains plausible.
- Treat `replace` as destructive: it removes the existing records for one date,
  then writes the replacement. Confirm that this matches the user's request.
- Require successful post-write verification. If the result is uncertain or the
  server returns an unexpected error, stop instead of blindly retrying.

## Authentication

On macOS, the script can import only NikaTime's encrypted cookie from the default
Chrome profile. It uses Chrome Safe Storage in memory and does not print the key
or plaintext cookie. A macOS Keychain prompt may require user approval.

The cookie is stored in a dedicated reusable profile. If that session expires,
the script opens NikaTime's Slack OAuth flow. Let the user complete credentials or
MFA; do not automate those secrets. Set `NIKATIME_SKIP_CHROME_IMPORT=1` when the
dedicated profile is already authenticated and another Keychain prompt is not
needed. `NIKATIME_BROWSER_PROFILE` can select a shared profile location.

## Workflow

Run commands from the skill directory or use the absolute script path. Always
pass an explicit `--month YYYY-MM`.

The skill includes its Playwright runtime under `scripts/node_modules`. If a
copied installation does not include it, run
`cd scripts && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --omit=dev`; the
script uses the installed Google Chrome browser rather than downloading one.

1. Inspect the month and validate the account and configured workday duration:

   ```bash
   node scripts/nikatime.cjs inspect --month 2026-08
   ```

2. Resolve project IDs from the same project dropdown used by NikaTime:

   ```bash
   node scripts/nikatime.cjs projects --month 2026-08
   ```

3. Prepare the intended operation and run it without `--apply`.
4. Verify the dry-run output against the user's request.
5. If submission is authorized, rerun the identical command with `--apply`.
6. Report the verified records and any dates deliberately left unchanged.

## Operation modes

Fill one date or all missing weekdays with one project:

```bash
node scripts/nikatime.cjs fill \
  --month 2026-08 \
  --date 2026-08-26 \
  --project-id PROJECT_ID \
  --hours 8 \
  --note "Work description"
```

For multiple dates, create a JSON array. `hours` is optional and defaults to the
account's workday duration:

```json
[
  {
    "date": "2026-08-03",
    "projectId": "PROJECT_ID",
    "hours": 8,
    "notes": "Work description"
  }
]
```

Preview and apply it with:

```bash
node scripts/nikatime.cjs batch --month 2026-08 --file /absolute/path/entries.json
node scripts/nikatime.cjs batch --month 2026-08 --file /absolute/path/entries.json --apply
```

`batch` is idempotent by total daily hours: it adds only each date's remaining
gap and rejects duplicate dates in one manifest. Use `replace` when correcting an
existing day or splitting it among projects or time-off categories. A replacement
manifest may contain multiple entries, but they must all use the same date:

```bash
node scripts/nikatime.cjs replace --month 2026-08 --file /absolute/path/replacement.json
node scripts/nikatime.cjs replace --month 2026-08 --file /absolute/path/replacement.json --apply
```

For a month containing both ordinary full days and a split day, create two
manifests: preview/apply the ordinary dates with `batch`, and preview/apply all
parts of the split date together with `replace`. Show and verify both dry runs
before using `--apply`.

The replacement path captures rollback data, deletes the date, writes the new
records, and verifies the exact date/project/hour/note set. If the write is
rejected or verification fails after deletion, it attempts to restore and verify
the prior records. Treat an `URGENT` restoration error as requiring immediate
manual review of that date.

The private web endpoint requires compact `yyyyMMdd` dates on writes despite its
published schema; the script handles this conversion. Do not reimplement it in an
ad hoc request unless diagnosing a script defect.
