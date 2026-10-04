const path = require("path");

// npm's .cmd shim for a package that ships a native binary ends in a line like
//   "%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe"   %*
const NATIVE_SHIM_TARGET = /"%dp0%\\([^"]+\.exe)"/i;

// Picks something `spawn` can run without a shell from `where <name>` output.
// `where` lists npm's extensionless and .cmd shims first, and Node refuses to
// spawn a .cmd without a shell; going through one would expose the dictated
// prompt to cmd.exe's quoting rules.
function pickWindowsExecutable(whereOutput, readFile) {
  const hits = whereOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const exe = hits.find((hit) => hit.toLowerCase().endsWith(".exe"));
  if (exe) return exe;

  for (const hit of hits.filter((h) => h.toLowerCase().endsWith(".cmd"))) {
    let shim;
    try {
      shim = readFile(hit);
    } catch {
      continue;
    }
    const target = NATIVE_SHIM_TARGET.exec(shim);
    if (target) return path.win32.join(path.win32.dirname(hit), target[1]);
  }
  return null;
}

module.exports = { pickWindowsExecutable };
