---
name: nikatime-timesheets
description: Inspect, preview, create, batch-fill, and safely replace NikaTime web timesheet entries, using Vacation Tracker leave as time-off evidence. Use when the user asks to read or fill NikaTime dates, projects, hours, notes, vacation, or other time off; do not use for unrelated time trackers.
---

# NikaTime Timesheets

Use `scripts/nikatime.cjs` for deterministic NikaTime reads and writes and for
read-only Vacation Tracker leave lookup. It talks to both services directly
over HTTPS using sessions recovered from Chrome's own storage; no browser is
launched for `projects`, `show`, `vacations`, `batch`, `replace`, or `fill`
unless a session cannot be renewed directly. `inspect` always drives a real
Chrome window, since discovering the live NikaTime API calls the web app makes
requires watching real browser network traffic.

## Safety and authorization

- Never ask the user to paste or reveal `authCookie`, Vacation Tracker Cognito
  tokens, Slack credentials, or MFA.
- Read operations (`inspect`, `projects`, `show`, `vacations`, and commands
  without `--apply`) are safe preparation. Run a dry run before every mutation
  and show or check the exact dates, project IDs, hours, and notes.
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

For `vacations`, the script snapshots Chrome's local-storage LevelDB, reads only
Vacation Tracker's Cognito session keys, and queries Vacation Tracker's
first-party GraphQL endpoint directly. It never prints the ID or refresh token.
An expired ID token is refreshed directly with Cognito, so a browser is not
normally involved. Only when the stored session is missing or cannot refresh
does it open a dedicated Chrome profile for interactive sign-in. Let the user
complete credentials or MFA; do not automate those secrets. Set
`VACATIONTRACKER_SKIP_BROWSER_FALLBACK=1` to fail instead of opening that login
window, `VACATIONTRACKER_CHROME_LOCAL_STORAGE` to select another Chrome
local-storage database, or `VACATIONTRACKER_BROWSER_PROFILE` to select the
fallback profile.

## Workflow

Run commands from the skill directory or use the absolute script path. Always
pass an explicit `--month YYYY-MM`.

The skill includes its runtime dependencies under `scripts/node_modules`.
`classic-level` reads a snapshot of Chrome local storage without opening a
browser; Playwright is needed only for `inspect` and interactive session
renewal. If a copied installation does not include them, run `cd scripts &&
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --omit=dev`; the script uses the
installed Google Chrome browser rather than downloading one. `projects`,
`show`, `vacations`, `batch`, `replace`, and `fill` do not need Playwright at
all as long as the imported sessions are valid.

1. Inspect the month and validate the account and configured workday duration:

   ```bash
   node scripts/nikatime.cjs inspect --month 2026-08
   ```

2. Resolve project IDs from the same project dropdown used by NikaTime:

   ```bash
   node scripts/nikatime.cjs projects --month 2026-08
   ```

3. Before writing anything, check what is already on file for every date you
   are about to touch:

   ```bash
   node scripts/nikatime.cjs show --month 2026-08 --date 2026-08-26
   node scripts/nikatime.cjs show --month 2026-08
   ```

   Do this even for dates you expect to be empty. `batch` (see below) is
   idempotent by total hours only — a date that already has its full target
   hours entered under the *wrong* project is invisible to `batch` and will
   be silently left wrong. `show` is the reliable way to see what a date
   actually holds; do not rely on a `replace` dry run's `previous` field as a
   substitute for checking first, and do not assume a date is empty just
   because the user hasn't mentioned it.
4. Prepare the intended operation and run it without `--apply`.
5. Verify the dry-run output against the user's request. For `batch`, also
   read any printed mismatch warning (see Operation modes below) — a date
   listed there needs `replace`, not `batch`, or it will not change.
6. If submission is authorized, rerun the identical command with `--apply`.
7. Report the verified records and any dates deliberately left unchanged.

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

`batch` is idempotent by total daily hours only: it adds only each date's
remaining gap and rejects duplicate dates in one manifest. It never checks
*which* project the existing hours belong to. That means a date that already
has a full day entered under a different project is a silent no-op for
`batch` — the day stays mislabeled and nothing in `batch`'s own output says
so unless you read the mismatch warning it prints for exactly this case (see
`show`, above, for confirming this ahead of time). Use `replace` when
correcting an existing day, relabeling a full day logged under the wrong
project, or splitting a day among projects or time-off categories. A
replacement manifest may contain multiple entries, but they must all use the
same date — this also covers a day genuinely split between two or more
*workstreams* (not only a workstream plus time-off): give each workstream its
own entry with its own hours summing to the day's total.

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
2. Read the user's approved leave from Vacation Tracker for every calendar
   month touched by the horizon:

   ```bash
   node scripts/nikatime.cjs vacations --month 2026-08
   ```

   This command reads the Leaves tab at
   `https://app.vacationtracker.io/app/my-profile?activeTab=leaves` through its
   first-party API and returns only approved requests overlapping the month.
   Its `days` array is authoritative time-off evidence: each item includes the
   date, Vacation Tracker leave type, exact leave hours, normal working hours,
   and whether it is a full day. Match the returned `leaveType` to an exact live
   NikaTime entry with `timeOff: true`; if there is no unambiguous exact match,
   ask the user which live time-off label to use rather than guessing.

   A full day is classified wholly as that time-off label. A partial day is a
   split day: preserve the exact leave hours and investigate/classify only the
   remaining work hours. If Vacation Tracker returns a leave date without exact
   hours, treat the allocation as unresolved and ask the user before preparing
   a manifest. Never infer that a quiet day was vacation when Vacation Tracker
   has no approved leave record for it.
3. Go straight into investigating the user's activity for the non-time-off
   portion of that horizon (the
   evidence workflow, classification rules, and time-off rules in
   `references/monthly-workday-allocation.md`, originally a Glean skill) —
   do not ask for permission before pulling Slack, GitHub, or Glean activity
   data.

   A Glean `user_activity` call covering even a single 5-weekday window
   routinely returns well over 150,000 characters, which overflows a normal
   tool result and gets redirected to a file. Expect this rather than
   discovering it mid-task: fetch the activity, then hand the saved file plus
   the classification instructions to a forked/background subagent to read
   in full and produce the day-by-day mapping, instead of trying to read and
   reason over that volume inline. Do the same per distinct horizon (e.g. one
   fork per week) rather than one giant fetch-and-read pass.
4. Check whether the `glean_default` MCP server is connected in this session.
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
5. Classify each weekday in the horizon under the live labels pulled in step
   1, combining Vacation Tracker time-off evidence from step 2 with cited
   activity evidence for the remaining hours. Match each classification to a
   live `name` with an exact match. If nothing in the live list fits, report
   the day or remaining hours as Unclassified rather than inventing a label —
   do not guess or invent a project ID or name. This produces a `date -> live
   label and hours` mapping.
6. Present that mapping to the user as a proposed classification, one entry
   per date, and get explicit confirmation that the labels are correct before
   proceeding. Correct any label the user disputes and reconfirm.

   The live label list frequently has several near-identical entries across
   teams (e.g. a `Tech Debt` and an `Other` label per team prefix). If the
   user corrects a label with a bare name that matches more than one live
   entry (e.g. "make it Tech Debt" when `SWARM:`, `DI:`, `AT:`, `FIX:`, `PT:`,
   `RFQ:`, `TA:`, `UI:`, `POST:`, and `DINT:` all have one), do not silently
   pick one. Default to the same team prefix as the label already under
   discussion for that date when that's a plausible read, but confirm the
   exact live name with the user (for example via a short multiple-choice
   question) rather than guessing across teams.
7. Turn the confirmed mapping into a `batch` manifest for ordinary days and a
   `replace` manifest for split, time-off, or corrected days, then continue
   with the normal workflow: run `show` on every date first to confirm what
   is already there, preview both dry runs, verify them against the
   confirmed classification, and apply only if the user authorizes the
   write.
