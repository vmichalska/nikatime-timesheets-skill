---
name: nikatime-timesheets
description: Inspect, preview, create, batch-fill, and safely replace NikaTime web timesheet entries using browser-managed authentication. Use when the user asks to read or fill NikaTime dates, projects, hours, notes, vacation, or other time off; do not use for unrelated time trackers.
---

# NikaTime Timesheets

Use `scripts/nikatime.cjs` for deterministic NikaTime reads and writes. It talks
to NikaTime's API directly over HTTPS using the `authCookie` decrypted straight
out of Chrome's own storage; no browser is launched for `projects`, `batch`,
`replace`, or `fill` unless that session cannot renew itself. `inspect` always
drives a real Chrome window, since discovering the live API calls the web app
makes requires watching real browser network traffic.

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

On macOS, the script decrypts NikaTime's encrypted cookie straight out of the
default Chrome profile's own storage (Chrome Safe Storage, held in memory) and
uses that value directly in the `Cookie` header of its own HTTPS requests. It
does not print the key or plaintext cookie. A macOS Keychain prompt may require
user approval.

For `projects`, `batch`, `replace`, and `fill`, this decrypted value is used
immediately — no browser is opened at all as long as that session is valid.
If it is missing or cannot renew itself, the script opens a dedicated, reusable
Chrome profile in a visible window and starts NikaTime's Slack OAuth flow. Let
the user complete credentials or MFA in that window; do not automate those
secrets. Once login completes, the script reads the freshly issued cookie back
out of that browser, closes it, and continues over plain HTTPS for the rest of
the run.

`inspect` always opens that dedicated profile in Chrome (headless by default,
since discovering the API calls only requires watching network traffic, not a
visible window) and falls back to a visible window the same way if its own
session cannot renew automatically. Pass `--headed` to `inspect` to always show
the window (for example, to watch a run or debug).

Set `NIKATIME_SKIP_CHROME_IMPORT=1` when the dedicated profile is already
authenticated and another Keychain prompt is not needed.
`NIKATIME_BROWSER_PROFILE` can select a shared profile location.

## Workflow

Run commands from the skill directory or use the absolute script path. Always
pass an explicit `--month YYYY-MM`.

The skill includes its Playwright runtime under `scripts/node_modules`, needed
only for `inspect` and for interactive session renewal. If a copied
installation does not include it, run `cd scripts &&
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --omit=dev`; the script uses the
installed Google Chrome browser rather than downloading one. `projects`,
`batch`, `replace`, and `fill` do not need Playwright at all as long as the
imported session is valid.

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

## Classifying a time horizon without explicit days or projects

If the user asks to fill in NikaTime but has not supplied specific dates,
project IDs, or a manifest, the intent is: investigate what the user actually
did in the given time horizon, categorize each weekday under the available
labels, confirm those labels with the user, and only then write anything to
NikaTime. Never guess or invent an allocation, and never write before the
user has confirmed the labels.

If no time horizon was given, assume today. Otherwise use whatever horizon
the user named (a day, a week, a month, a date range); it does not have to
align with a calendar month, though the underlying `nikatime.cjs` commands
still operate through `--month` and, where supported, `--date`.

1. Pull the live label set first, before investigating anything. NikaTime's
   project IDs, names, and time-off entries all live in one dropdown that
   changes over time, so resolve it fresh for the target month rather than
   assuming any fixed list:

   ```bash
   node scripts/nikatime.cjs projects --month 2026-08
   ```

   Entries with `timeOff: true` are the available time-off labels; the rest
   are the available workstream projects. This live list is the only valid
   set of labels to classify into.
2. Go straight into investigating the user's activity for that horizon (the
   evidence workflow, classification rules, and time-off rules in
   `references/monthly-workday-allocation.md`, originally a Glean skill) —
   do not ask for permission before pulling Slack, GitHub, or Glean activity
   data.
3. Check whether the `glean_default` MCP server is connected in this session.
   - If connected, follow `references/monthly-workday-allocation.md`
     directly, using `mcp__glean_default__user_activity`,
     `mcp__glean_default__code_search`, and `mcp__glean_default__search` as
     its evidence tools.
   - If Glean is not connected, or its results show no indexed Slack or
     GitHub activity for the user, stop and ask whether the agent should
     instead connect to Slack and GitHub directly through whatever
     integration the current client (Claude, Codex, or Cursor) has
     available, then apply the same evidence and citation rules against
     those sources.
4. Classify each weekday in the horizon under the live labels pulled in step
   1, with citations. Match each classification to a live `name` with an
   exact match. If nothing in the live list fits, report the day as
   Unclassified rather than inventing a label — do not guess or invent a
   project ID or name. This produces a `date -> live label` mapping.
5. Present that mapping to the user as a proposed classification, one entry
   per date, and get explicit confirmation that the labels are correct before
   proceeding. Correct any label the user disputes and reconfirm.
6. Turn the confirmed mapping into a `batch` manifest for ordinary days and a
   `replace` manifest for split or time-off days, then continue with the
   normal workflow: preview both dry runs, verify them against the confirmed
   classification, and apply only if the user authorizes the write.
