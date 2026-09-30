#!/usr/bin/env node

/*
 * NikaTime CLI entrypoint. Implementation lives in focused modules under lib/:
 * CLI parsing, periods, API access, sessions, planning, command workflows, and
 * Vacation Tracker integration can each be understood and tested separately.
 */

const path = require("node:path");
const { spawnSync } = require("node:child_process");

async function runCli() {
  const { attemptAutoUpdate } = require("./lib/auto-update.cjs");
  const update = attemptAutoUpdate({
    rootDir: path.resolve(__dirname, ".."),
  });

  if (update.updated) {
    const restarted = spawnSync(process.execPath, [__filename, ...process.argv.slice(2)], {
      env: {
        ...process.env,
        NIKATIME_AUTO_UPDATE_RESTARTED: "1",
      },
      stdio: "inherit",
    });
    if (restarted.error) throw restarted.error;
    process.exitCode = restarted.status === null ? 1 : restarted.status;
    return;
  }

  const { main } = require("./lib/app.cjs");
  await main();
}

if (require.main === module) {
  runCli().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
} else {
  const { main } = require("./lib/app.cjs");
  const { parseArgs } = require("./lib/cli.cjs");
  const {
    normalizeNikaTimeCookie,
    readCachedSessionCookie,
    writeCachedSessionCookie,
  } = require("./lib/nikatime-session.cjs");

  // Preserve the programmatic surface used by existing callers and tests.
  module.exports = {
    main,
    normalizeNikaTimeCookie,
    parseArgs,
    readCachedSessionCookie,
    writeCachedSessionCookie,
  };
}
