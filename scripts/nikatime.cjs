#!/usr/bin/env node

/*
 * NikaTime CLI entrypoint. Implementation lives in focused modules under lib/:
 * CLI parsing, periods, API access, sessions, planning, command workflows, and
 * Vacation Tracker integration can each be understood and tested separately.
 */

const { main } = require("./lib/app.cjs");
const { parseArgs } = require("./lib/cli.cjs");
const {
  normalizeNikaTimeCookie,
  readCachedSessionCookie,
  writeCachedSessionCookie,
} = require("./lib/nikatime-session.cjs");

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}

// Preserve the programmatic surface used by existing callers and tests.
module.exports = {
  main,
  normalizeNikaTimeCookie,
  parseArgs,
  readCachedSessionCookie,
  writeCachedSessionCookie,
};
