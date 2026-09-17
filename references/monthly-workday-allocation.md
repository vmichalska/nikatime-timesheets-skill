# Monthly Workday Allocation

Vendored from the `monthly-workday-allocation` Glean skill
(https://app.glean.com/settings/skills). This is reference material for the
optional auto-classification fallback described in `SKILL.md` — it is not
invoked remotely; the agent follows these instructions directly, using
whichever evidence tools (Glean MCP, or direct Slack/GitHub integrations) the
current session has connected. Keep this file in sync with the Glean skill by
re-pasting its markdown here if you edit it in Glean.

Produce an evidence-based, day-by-day allocation of a user's weekdays for a
specified time horizon.

## Required inputs

The target time horizon (a day, week, month, or date range; SKILL.md assumes
today if the user did not name one) and the set of valid labels. Per
SKILL.md, the label set is **not** the static catalog below — it is pulled
live for that horizon from `node scripts/nikatime.cjs projects --month
YYYY-MM` before any investigation starts, since that catalog is a vendored
snapshot that can go stale. Entries with `timeOff: true` are the valid
time-off labels; the rest are the valid workstream projects. Classify only
into labels present in that live list. Do not infer ownership from the
user's identity, department, previous conversations, or the fact that a
category appears in the (now historical) catalog below.

## Workstream catalog (historical reference only — do not classify against this)

This is the catalog as originally vendored from the Glean skill. It is kept
here only as background on the kind of labels NikaTime has used; it is not
authoritative and must not be used to classify a day. Always use the live
label set from step 1 of SKILL.md instead. Use labels exactly as written.
Repeated entries in the source list are treated as one selectable option.

Activity Simulation
Activity Sim Perf Test
Applied AI
Applied AI: Tiobi & Studio
AT
AT: Client Feedback
AT: Hedging
AT: Voice Processing
AT: Activity Simulation
AT: Analytics
AT: Axe Finder
AT: Axe Manager
AT: FSS Decomposition
AT: MMY
AT: Other
AT: Placement Management
AT: Saleslink Improvement
AT: Scalability
AT: Tech Debt
CLOUD
CLOUD: Active Passive Envs
CLOUD: Auth Modernization
CLOUD: Eurex
CLOUD: Other
CORE
CORE: Auth Modernization
CORE: Other
CORE: Tracing
CORE: USS Decomposition
CORE: xDS
DI
DI: Dealer Recommender
DI: AI Integration
DI: Alloy DB
DI: Automation
DI: Backtesting Framework
DI: Baskets
DI: Bid Offer Improvements
DI: Core Infra Modernization
DI: Dark Streams
DI: Data Commercialization
DI: Fat Finger Checks
DI: FST & Swarm Support
DI: FVMP 2+
DI: FVMP to AWS
DI: FVMP V2
DI: GenAI
DI: MMY
DI: Net Auction
DI: Other
DI: Otto
DI: Replay Framework
DI: Tech Debt
DI: Trucalc
DI: XR Pricing
DINT
DINT: AI Integration
DINT: Analytics
DINT: Eurex
DINT: Scalability
DINT: Baskets
DINT: Data Commercialization
DINT: MMY
DINT: New Issue Monitor
DINT: Other
DINT: Tech Debt
DINT: Trucalc (Numerix)
DOPS
DOPS: Active Passive Envs
DOPS: Daily Releases
DOPS: Daytona Upgrade
DOPS: Disruptable Services
DOPS: Other
FIX
FIX: Aladdin ECN
FIX: Baskets
FIX: New Features
FIX: Placement Management
FIX: Activity Simulation
FIX: Eurex
FIX: FSS Decomposition
FIX: Historic MD delivery
FIX: List Placement Management
FIX: MMY
FIX: Other
FIX: Scalability
FIX: Tech Debt
FIX: TRACE Comm
Link
Link Pro
Link: Conversational AI
OBS
OBS: Active Passive Envs
OBS: AI Integration
OBS: DB Resiliency Security Efficiency
OBS: ELK Logging Buildout
OBS: Eurex
OBS: IM Tooling
OBS: Metrics Logging Platform
OBS: Other
POST
POST: Analytics
POST: Baskets
POST: CATS Team
POST: Fees
POST: Greys
POST: Eurex
POST: Other
POST: Post-Trade V2
POST: Rates Hedging
POST: Scalability
POST: Tech Debt
PT
PT: Fees
PT: MMY
PT: Notifications
PT: Placement Management
PT: Activity Simulation
PT: Analytics
PT: Integration
PT: New Features
PT: Other
PT: Protocol Extension
PT: Scalability
PT: Tech Debt
PT: Trade Automation
QA
QA: Daily Releases
RFQ
RFQ: Historical Activity
RFQ: MMY
RFQ: Activity Simulation
RFQ: Aeron Migration
RFQ: Analytics
RFQ: Eurex
RFQ: Integration
RFQ: New Features
RFQ: Notifications
RFQ: Other
RFQ: Placement Management
RFQ: Scalability
RFQ: Tech Debt
RFQ: Trade Automation
SWARM
SWARM: Notifications
SWARM: Placement Management
SWARM: Scalability
SWARM: Tech Debt
SWARM: Baskets
SWARM: Dark Streams
SWARM: FVMP 2+
SWARM: Otto
SWARM: Activity Sim
SWARM: Client Feedback
SWARM: Emerging Markets
SWARM: FSS Decomposition
SWARM: Internal Tools
SWARM: Net
SWARM: Other
SWARM: Trade Automation
TA
TA: Autopilot
TA: FST
TA: Analytics
TA: MMY
TA: Other
TA: Tech Debt
TA: Trade Automation
UI
UI: Auth Modernization
UI: Other
UI: R&D
UI: Table UX
UI: Tech Debt
UI: Workspaces

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

- Allocate each weekday to exactly one workstream or time-off label from the
  live label list.
- Choose the strongest coherent theme for the day, not the last event or the
  highest message count.
- Prefer the user's own merged code over code merely reviewed or discussed.
- Use Slack as corroboration or as a secondary signal; do not let casual
  conversation outweigh merged code.
- Group stacked PRs that implement one feature under that feature's
  workstream.
- Do not assign a workstream that is not present in the live label list,
  even if it appears in the historical catalog.
- If nothing in the live label list fits, report the day as Unclassified
  rather than inventing a label, and explain the gap briefly.
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

After the list, include a compact count by label and a short note for
excluded weekends, unclassified days, or evidence limitations. Do not include
any label absent from the live label list in the allocation.

## Quality checks

Before responding, verify:

- Every label used was present in the live label list pulled from NikaTime
  for this horizon, not the historical catalog above.
- Every weekday is accounted for or explicitly excluded.
- No time-off category is inferred without explicit evidence.
- Merged code received priority over Slack-only activity.
- No category outside the live label list was assigned.
- A mistaken classification is corrected rather than defended when the user
  provides new information.
- Every factual source-derived claim has a nearby citation.
