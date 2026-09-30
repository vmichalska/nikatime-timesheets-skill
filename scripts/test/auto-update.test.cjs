const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  attemptAutoUpdate,
  isAutoUpdateEnabled,
} = require("../lib/auto-update.cjs");

function result(status, stdout = "", stderr = "") {
  return { status, stdout, stderr };
}

function createCheckout() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "nikatime-update-"));
  fs.mkdirSync(path.join(rootDir, "scripts"));
  fs.writeFileSync(path.join(rootDir, "scripts", "package-lock.json"), "old-lock\n");
  return rootDir;
}

test("automatic updates are enabled by default and can be opted out", () => {
  assert.equal(isAutoUpdateEnabled({}), true);
  for (const value of ["0", "false", "NO", "off"]) {
    assert.equal(isAutoUpdateEnabled({ NIKATIME_AUTO_UPDATE: value }), false);
  }
  assert.equal(isAutoUpdateEnabled({ NIKATIME_AUTO_UPDATE: "1" }), true);
});

test("disabled automatic updates do not invoke git", () => {
  let calls = 0;
  const update = attemptAutoUpdate({
    env: { NIKATIME_AUTO_UPDATE: "0" },
    runCommand: () => {
      calls += 1;
      return result(0);
    },
  });
  assert.deepEqual(update, { updated: false, reason: "disabled" });
  assert.equal(calls, 0);
});

test("a clean checkout fast-forwards and refreshes changed dependencies", (t) => {
  const rootDir = createCheckout();
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const calls = [];
  const runCommand = (command, args, options) => {
    calls.push([command, args]);
    if (command === "npm") return result(0);
    const gitArgs = args.slice(2);
    if (gitArgs[0] === "rev-parse" && gitArgs[1] === "--show-toplevel") {
      return result(0, `${rootDir}\n`);
    }
    if (gitArgs[0] === "status") return result(0, "");
    if (gitArgs[0] === "rev-parse" && gitArgs[1] === "HEAD") {
      const headReads = calls.filter(([, callArgs]) =>
        callArgs[2] === "rev-parse" && callArgs[3] === "HEAD"
      ).length;
      return result(0, headReads === 1 ? "1111111\n" : "2222222\n");
    }
    if (gitArgs[0] === "pull") {
      fs.writeFileSync(
        path.join(rootDir, "scripts", "package-lock.json"),
        "new-lock\n",
      );
      return result(0);
    }
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };

  const originalError = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(attemptAutoUpdate({ rootDir, runCommand }), {
      updated: true,
      reason: "updated",
    });
  } finally {
    console.error = originalError;
  }
  assert.equal(calls.some(([command]) => command === "npm"), true);
});

test("a dirty checkout is left untouched", (t) => {
  const rootDir = createCheckout();
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  let pulled = false;
  const warnings = [];
  const runCommand = (command, args) => {
    const gitArgs = args.slice(2);
    if (gitArgs[0] === "rev-parse") return result(0, `${rootDir}\n`);
    if (gitArgs[0] === "status") return result(0, " M SKILL.md\n");
    if (gitArgs[0] === "pull") pulled = true;
    return result(0);
  };

  assert.deepEqual(
    attemptAutoUpdate({
      rootDir,
      runCommand,
      warn: (message) => warnings.push(message),
    }),
    { updated: false, reason: "dirty-checkout" },
  );
  assert.equal(pulled, false);
  assert.match(warnings[0], /local changes/);
});

test("a pull failure warns and continues with the installed version", (t) => {
  const rootDir = createCheckout();
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const warnings = [];
  const runCommand = (command, args) => {
    const gitArgs = args.slice(2);
    if (gitArgs[0] === "rev-parse" && gitArgs[1] === "--show-toplevel") {
      return result(0, `${rootDir}\n`);
    }
    if (gitArgs[0] === "status") return result(0, "");
    if (gitArgs[0] === "rev-parse") return result(0, "1111111\n");
    if (gitArgs[0] === "pull") return result(1, "", "network unavailable");
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };

  assert.deepEqual(
    attemptAutoUpdate({
      rootDir,
      runCommand,
      warn: (message) => warnings.push(message),
    }),
    { updated: false, reason: "pull-failed" },
  );
  assert.match(warnings[0], /continuing with the installed version/);
});
