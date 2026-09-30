const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DISABLED_VALUES = new Set(["0", "false", "no", "off"]);
const UPDATE_TIMEOUT_MS = 15_000;
const INSTALL_TIMEOUT_MS = 120_000;

function isAutoUpdateEnabled(env = process.env) {
  const configured = env.NIKATIME_AUTO_UPDATE;
  return configured === undefined ||
    !DISABLED_VALUES.has(String(configured).trim().toLowerCase());
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    ...options,
  });
}

function outputLine(result) {
  const output = String(result.stderr || result.stdout || "").trim();
  return output.split(/\r?\n/)[0] || `exit status ${result.status}`;
}

function fileDigest(filePath) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function git(rootDir, args, env, runCommand) {
  return runCommand("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
    env: {
      ...env,
      GIT_TERMINAL_PROMPT: "0",
    },
    maxBuffer: 1024 * 1024,
    timeout: UPDATE_TIMEOUT_MS,
  });
}

function attemptAutoUpdate({
  rootDir = path.resolve(__dirname, "../.."),
  env = process.env,
  runCommand = run,
  warn = console.warn,
} = {}) {
  if (!isAutoUpdateEnabled(env) || env.NIKATIME_AUTO_UPDATE_RESTARTED === "1") {
    return { updated: false, reason: "disabled" };
  }

  const canonicalRoot = fs.realpathSync(rootDir);
  const topLevel = git(canonicalRoot, ["rev-parse", "--show-toplevel"], env, runCommand);
  if (topLevel.status !== 0) {
    return { updated: false, reason: "not-a-git-checkout" };
  }

  let canonicalTopLevel;
  try {
    canonicalTopLevel = fs.realpathSync(String(topLevel.stdout).trim());
  } catch {
    return { updated: false, reason: "not-a-git-checkout" };
  }
  if (canonicalTopLevel !== canonicalRoot) {
    return { updated: false, reason: "nested-checkout" };
  }

  const status = git(canonicalRoot, ["status", "--porcelain=v1"], env, runCommand);
  if (status.status !== 0) {
    warn(`[nikatime] Automatic update skipped: ${outputLine(status)}.`);
    return { updated: false, reason: "status-failed" };
  }
  if (String(status.stdout).trim()) {
    warn("[nikatime] Automatic update skipped because the skill checkout has local changes.");
    return { updated: false, reason: "dirty-checkout" };
  }

  const before = git(canonicalRoot, ["rev-parse", "HEAD"], env, runCommand);
  if (before.status !== 0) {
    warn(`[nikatime] Automatic update skipped: ${outputLine(before)}.`);
    return { updated: false, reason: "head-unavailable" };
  }

  const lockfile = path.join(canonicalRoot, "scripts", "package-lock.json");
  const dependencyDigest = fileDigest(lockfile);
  const pull = git(canonicalRoot, ["pull", "--ff-only", "--quiet"], env, runCommand);
  if (pull.status !== 0) {
    warn(`[nikatime] Automatic update failed; continuing with the installed version: ${outputLine(pull)}.`);
    return { updated: false, reason: "pull-failed" };
  }

  const after = git(canonicalRoot, ["rev-parse", "HEAD"], env, runCommand);
  if (after.status !== 0 || String(after.stdout).trim() === String(before.stdout).trim()) {
    return { updated: false, reason: "up-to-date" };
  }

  if (fileDigest(lockfile) !== dependencyDigest) {
    const install = runCommand("npm", ["install", "--omit=dev"], {
      cwd: path.join(canonicalRoot, "scripts"),
      encoding: "utf8",
      env: {
        ...env,
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
      },
      maxBuffer: 1024 * 1024,
      timeout: INSTALL_TIMEOUT_MS,
    });
    if (install.status !== 0) {
      throw new Error(
        `The skill updated, but its dependencies could not be refreshed: ${outputLine(install)}`,
      );
    }
  }

  console.error(
    `[nikatime] Updated skill ${String(before.stdout).trim().slice(0, 7)} -> ${String(after.stdout).trim().slice(0, 7)}.`,
  );
  return { updated: true, reason: "updated" };
}

module.exports = {
  attemptAutoUpdate,
  isAutoUpdateEnabled,
};
