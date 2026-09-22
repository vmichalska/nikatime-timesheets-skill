const {
  parseArgs,
  usage,
  validateArgs,
  validateCommand,
} = require("./cli.cjs");
const { runDirectCommand, runInspect } = require("./commands.cjs");
const { createPeriod } = require("./date-utils.cjs");
const { prepareInitialSession } = require("./nikatime-session.cjs");
const { validateNotes, validateProjectId } = require("./plans.cjs");
const { runVacations } = require("./vacation-tracker.cjs");

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return;
  }

  validateCommand(args);
  const period = createPeriod(args.month);
  validateArgs(args, period);
  if (args.command === "vacations") {
    await runVacations(period);
    return;
  }
  if (args.command === "fill") {
    validateProjectId(args.projectId, "fill");
    validateNotes(args.note, "fill");
  }

  // Default Chrome import is deliberately explicit because macOS can require
  // the user's password for Chrome Safe Storage access.
  const initialSession = prepareInitialSession(args);
  if (args.command === "inspect") {
    await runInspect(args, initialSession, period);
    return;
  }
  await runDirectCommand(args, initialSession, period);
}

module.exports = { main };
