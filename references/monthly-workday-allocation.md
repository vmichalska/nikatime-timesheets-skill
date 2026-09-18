# Monthly Workday Allocation

Adapted from the `monthly-workday-allocation` Glean skill
(https://app.glean.com/settings/skills). This is reference material for the
auto-classification workflow described in `SKILL.md` — it is not invoked
remotely; the agent follows these instructions directly, using whichever
evidence tools (Glean MCP, or direct Slack/GitHub integrations) the current
session has connected. Unlike the Glean skill, the valid labels here are
always pulled live from NikaTime rather than a fixed catalog, so this file
has intentionally diverged from it; do not copy the Glean skill's catalog
back into this file.

Produce an evidence-based, day-by-day allocation of a user's weekdays for a
specified time horizon.

## Required inputs

The target time horizon (a day, week, month, or date range; SKILL.md assumes
today if the user did not name one) and the set of valid labels. The label
set is pulled live for that horizon from `node scripts/nikatime.cjs projects
--month YYYY-MM` before any investigation starts (see SKILL.md step 1).
Entries with `timeOff: true` are the valid time-off labels; the rest are the
valid workstream projects. Classify only into labels present in that live
list. Do not infer ownership from the user's identity, department, or
previous conversations.

## Evidence workflow

1. Enumerate weekdays in the target month. Exclude weekends unless the user
   asks for a full calendar view.
2. Retrieve cross-app activity for the user and month with `user_activity`.
   A single 5-weekday window commonly returns well over 150,000 characters
   and will be saved to a file rather than returned inline. Read that file in
   full — in sequential chunks if needed — before classifying anything; do
   not classify from a partial read. This is expensive enough per horizon
   that it is usually worth delegating the read-and-classify step to a
   forked/background subagent per horizon (see SKILL.md's classification
   workflow) rather than pulling the raw dump into the main conversation.
3. Inspect merged or landed code first. Use `code_search` or GitHub activity
   to identify PRs authored by the user, merge status, merge/land date when
   available, and the work represented. Merged production code outranks
   opened, closed, abandoned, or review-only PRs.
4. Use authored Slack messages and threads to clarify intent, project
   context, testing, reviews, and work that produced no code artifact. Use
   calendar data and Slack for explicit time-off signals.
5. Keep source citation IDs with every selected evidence item. Cite each
   material workstream or time-off claim in the final response.

## Classification rules

- Allocate each weekday to exactly one workstream or time-off label from the
  live label list.
- Choose the strongest coherent theme for the day, not the last event or the
  highest message count.
- Prefer the user's own merged code over code merely reviewed or discussed.
- Use Slack as corroboration or as a secondary signal; do not let casual
  conversation outweigh merged code.
- Group stacked PRs that implement one feature under that feature's
  workstream.
- Do not assign a workstream that is not present in the live label list.
- If nothing in the live label list fits, report the day as Unclassified
  rather than inventing a label, and explain the gap briefly.
- Do not force a classification from silence. If a weekday has no
  attributable work evidence, mark it "No attributable activity" or ask
  whether the user wants those days included.
- Some weekdays genuinely split between two unrelated, similarly-dominant
  workstreams (e.g. two separate merged PRs in two different epics with no
  clear precedence). When the evidence doesn't support picking one, propose
  both candidate labels for that date and let the user choose or split it,
  rather than forcing a single label — see the split-workstream format below.
- The live label list often has several near-identical names across teams
  (a `Tech Debt` and an `Other` label per team prefix is common). If the
  strongest fit is ambiguous between team prefixes, or the user names a label
  without a prefix (e.g. "Tech Debt"), do not guess across teams silently.
  Prefer the team prefix already implicated by that day's evidence, state the
  assumption explicitly in the proposed mapping, and ask if more than one
  team is plausible.

## Time-off rules

- Use Vacation for any explicit vacation/away period, whether it covers the
  full day or only part of it (a generic "OOO" or unspecified time away also
  falls under Vacation).
- Use Day Off for an explicit full day off that is not identified as
  vacation, sick leave, parental leave, or a public holiday.
- Use Sick Day, Parental Leave, or Public Holiday only when explicitly
  supported by calendar, Slack, HR, or another authoritative source.
- A partial day can be written as: `<workstream> — Vacation (afternoon)`.
- A full-day time-off label overrides workstream activity for that date.
- Do not infer time off from a quiet day, missing commits, or lack of Slack
  messages.

## Output format

Lead with a one-sentence summary of the dominant work and the number of
weekdays classified.

Then provide one bullet per weekday, in chronological order:

```
- **Aug 14:** SWARM: Scalability — dedicated session-response topics and dual-write. <cite>...</cite>
```

For a full-day absence:

```
- **Aug 27:** Vacation — away from work. <cite>...</cite>
```

For a partial absence:

```
- **Aug 26:** SWARM: Placement Management — placement-warning work; Vacation in the afternoon. <cite>...</cite>
```

For a day genuinely split between two workstreams (not workstream + time-off),
present both candidates on one bullet rather than silently picking one, so the
user can choose a single label or confirm a split day:

```
- **Aug 28:** Split — CORE: USS Decomposition (dedicated session-response dual-consume rollout, merged) or SWARM: Tech Debt (paste-priority gating, merged); pick one or split the day's hours between both. <cite>...</cite>
```

After the list, include a compact count by label and a short note for
excluded weekends, unclassified days, or evidence limitations. Do not include
any label absent from the live label list in the allocation.

## Quality checks

Before responding, verify:

- Every label used was present in the live label list pulled from NikaTime
  for this horizon.
- Every weekday is accounted for or explicitly excluded.
- No time-off category is inferred without explicit evidence.
- Merged code received priority over Slack-only activity.
- No category outside the live label list was assigned.
- A mistaken classification is corrected rather than defended when the user
  provides new information.
- Every factual source-derived claim has a nearby citation.
