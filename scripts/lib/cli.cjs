const { isExactIsoDate } = require("./date-utils.cjs");

const COMMANDS = new Set([
  "inspect",
  "projects",
  "show",
  "vacations",
  "batch",
  "replace",
  "fill",
]);

function usage() {
  console.log(`Usage:
  node nikatime.cjs inspect --month YYYY-MM
  node nikatime.cjs projects --month YYYY-MM
  node nikatime.cjs show --month YYYY-MM [--date YYYY-MM-DD]
  node nikatime.cjs vacations --month YYYY-MM
  node nikatime.cjs batch --month YYYY-MM --file ENTRIES.json [--apply]
  node nikatime.cjs replace --month YYYY-MM --file ENTRIES.json [--apply]
  node nikatime.cjs fill --month YYYY-MM --project-id PROJECT_ID [--date YYYY-MM-DD] [--hours 8] [--note TEXT] [--apply]

Commands:
  inspect   Sign in if needed and summarize the month without writing anything.
  projects  List project IDs available to the month's entry form.
  show      Print the records already on file for one date, or every date in
            the month, with project names resolved. Read-only; never opens a
            browser beyond normal session renewal. Run this before batch or
            replace to see what is already there.
  vacations Read the signed-in user's approved Vacation Tracker leave for the
            month, including exact full-day and partial-day hours. Read-only.
  batch     Fill dates from a JSON array. Dry-run unless --apply is present.
  replace   Preview or replace all records on the manifest's single date.
  fill      Calculate gaps for the month's weekdays. Dry-run unless --apply is present.

Options:
  --project-id ID  NikaTime project ID to receive the missing hours.
  --month MONTH      Required month, formatted YYYY-MM.
  --date DATE       Limit the plan to one date, formatted YYYY-MM-DD.
  --hours NUMBER   Daily target. Defaults to NikaTime's workdayDuration.
  --note TEXT      Optional note added to every new record.
  --apply          Submit the planned records, then reload and verify.
  --headed         For inspect only: force a visible Chrome window even if
                   the session looks valid.
  --import-chrome  Explicitly import NikaTime's session from the default Chrome
                   profile. This can trigger a macOS Keychain password prompt.

projects, show, batch, replace, and fill talk to NikaTime directly over HTTPS
using an authCookie kept in a private owner-only session cache. On a cache miss,
a dedicated reusable Chrome profile recovers the session headlessly; a visible
window opens only if Slack login is required. Importing the default Chrome
profile is opt-in because its Safe Storage key can prompt for the macOS
password. inspect always opens the dedicated Chrome profile (headless by
default, visible if renewal is needed or --headed is passed), since discovering
the live API calls requires watching real browser network traffic.

vacations reads Vacation Tracker's Cognito session from a snapshot of Chrome's
local storage, refreshes it directly when needed, and queries the first-party
GraphQL API over HTTPS. It uses Playwright only as a last-resort login fallback.`);
}

function parseArgs(argv) {
  if (argv[0] === "--help" || argv[0] === "-h") {
    return { command: "inspect", help: true };
  }

  const result = {
    command: argv[0] || "inspect",
    apply: false,
    headed: false,
    importChrome: false,
    projectId: undefined,
    month: undefined,
    file: undefined,
    date: undefined,
    hours: undefined,
    note: "",
  };

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") result.apply = true;
    else if (arg === "--headed") result.headed = true;
    else if (arg === "--import-chrome") result.importChrome = true;
    else if (arg === "--project-id") result.projectId = argv[++index];
    else if (arg === "--month") result.month = argv[++index];
    else if (arg === "--file") result.file = argv[++index];
    else if (arg === "--date") result.date = argv[++index];
    else if (arg === "--hours") result.hours = Number(argv[++index]);
    else if (arg === "--note") result.note = argv[++index];
    else if (arg === "--help" || arg === "-h") result.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isFinite(result.hours) && result.hours !== undefined) {
    throw new Error("--hours must be a number");
  }
  if (result.hours !== undefined && (result.hours <= 0 || result.hours > 24)) {
    throw new Error("--hours must be greater than 0 and no more than 24");
  }
  if (result.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(result.date)) {
    throw new Error("--date must use YYYY-MM-DD");
  }
  return result;
}

function validateCommand(args) {
  if (!COMMANDS.has(args.command)) {
    usage();
    throw new Error(`Unknown command: ${args.command}`);
  }
}

function validateArgs(args, period) {
  validateCommand(args);
  if (args.command === "fill" && !args.projectId) {
    throw new Error("fill requires --project-id");
  }
  if (args.command === "batch" && !args.file) {
    throw new Error("batch requires --file");
  }
  if (args.command === "replace" && !args.file) {
    throw new Error("replace requires --file");
  }
  if (args.date && (args.date < period.start || args.date > period.end)) {
    throw new Error(`--date must fall within ${period.label}`);
  }
  if (args.date && !isExactIsoDate(args.date)) {
    throw new Error("--date must be a real date formatted YYYY-MM-DD");
  }
}

module.exports = { parseArgs, usage, validateArgs, validateCommand };
