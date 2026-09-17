# Monthly Workday Allocation

Vendored from the `monthly-workday-allocation` Glean skill. This is reference material for the
optional auto-classification fallback described in `SKILL.md` — it is not
invoked remotely; the agent follows these instructions directly, using
whichever evidence tools (Glean MCP, or direct Slack/GitHub integrations) the
current session has connected. Keep this file in sync with the Glean skill by
re-pasting its markdown here if you edit it in Glean.

Produce an evidence-based, day-by-day allocation of a user's weekdays for a
specified month.

## Required inputs

Require the user to provide:

- The target month and year.
- The user's workstream categories, selected from the catalog below.

Do not begin classification until the user has supplied the workstream
categories. If they provide no categories, ask them to select or paste their
categories. Do not infer ownership from the user's identity, department,
previous conversations, or the fact that a category appears in the catalog.

The following time-off labels are always available and do not need to be
selected:

- Day Off
- Parental Leave
- Public Holiday
- Sick Day
- Vacation

## Evidence workflow

1. Enumerate weekdays in the target month. Exclude weekends unless the user
   asks for a full calendar view.
2. Retrieve cross-app activity for the user and month with `user_activity`.
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

- Allocate each weekday to exactly one user-selected workstream or one
  time-off label.
- Choose the strongest coherent theme for the day, not the last event or the
  highest message count.
- Prefer the user's own merged code over code merely reviewed or discussed.
- Use Slack as corroboration or as a secondary signal; do not let casual
  conversation outweigh merged code.
- Group stacked PRs that implement one feature under that feature's selected
  workstream.
- Do not assign a workstream that the user did not select, even if it appears
  in the catalog.
- If no selected workstream fits, report the day as Unclassified rather than
  inventing a label, and explain the gap briefly.
- Do not force a classification from silence. If a weekday has no
  attributable work evidence, mark it "No attributable activity" or ask
  whether the user wants those days included.

## Time-off rules

- Use Vacation for any explicit vacation/away period, whether it covers the
  full day or only part of it (a generic "OOO" or unspecified time away also
  falls under Vacation).
- Use Day Off for an explicit full day off that is not identified as
  vacation, sick leave, parental leave, or a public holiday.
- Use Sick Day, Parental Leave, or Public Holiday only when explicitly
  supported by calendar, Slack, HR, or another authoritative source.
- A partial day can be written as: `<selected workstream> — Vacation
  (afternoon)`.
- A full-day time-off label overrides workstream activity for that date.
- Do not infer time off from a quiet day, missing commits, or lack of Slack
  messages.

## Output format

Lead with a one-sentence summary of the dominant work and the number of
weekdays classified.

Then provide one bullet per weekday, in chronological order:

```
- **Aug 14:** Team A: Scalability — message-queue migration work. <cite>...</cite>
```

For a full-day absence:

```
- **Aug 27:** Vacation — away from work. <cite>...</cite>
```

For a partial absence:

```
- **Aug 26:** Team B: Feature X — validation work; Vacation in the afternoon. <cite>...</cite>
```

After the list, include a compact count by label and a short note for
excluded weekends, unclassified days, or evidence limitations. Do not include
unselected catalog labels in the allocation.

## Quality checks

Before responding, verify:

- The user explicitly supplied the workstream categories used.
- Every weekday is accounted for or explicitly excluded.
- No time-off category is inferred without explicit evidence.
- Merged code received priority over Slack-only activity.
- No category outside the user's selected list was assigned.
- A mistaken classification is corrected rather than defended when the user
  provides new information.
- Every factual source-derived claim has a nearby citation.
