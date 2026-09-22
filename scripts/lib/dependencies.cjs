const path = require("node:path");

function loadDependency(candidates, message, transform = (loaded) => loaded) {
  for (const candidate of candidates.filter(Boolean)) {
    try {
      return transform(require(candidate));
    } catch (error) {
      if (error.code !== "MODULE_NOT_FOUND") throw error;
    }
  }
  throw new Error(message);
}

function loadPlaywright() {
  return loadDependency(
    [
      process.env.NIKATIME_PLAYWRIGHT_PATH,
      "playwright",
      path.join(__dirname, "..", "node_modules", "playwright"),
    ],
    "Playwright is unavailable. Set NIKATIME_PLAYWRIGHT_PATH or install Playwright locally.",
  );
}

function loadClassicLevel() {
  return loadDependency(
    [
      process.env.NIKATIME_CLASSIC_LEVEL_PATH,
      "classic-level",
      path.join(__dirname, "..", "node_modules", "classic-level"),
    ],
    "classic-level is unavailable. Run `cd scripts && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --omit=dev`.",
    (loaded) => loaded.ClassicLevel || loaded,
  );
}

module.exports = { loadClassicLevel, loadPlaywright };
