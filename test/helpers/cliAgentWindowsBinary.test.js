const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { pickWindowsExecutable } = require("../../src/helpers/cliAgent/windowsBinary");

const NPM_DIR = "C:\\nvm4w\\nodejs";
const NATIVE_SHIM = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
].join("\r\n");
const SCRIPT_SHIM = [
  "@ECHO off",
  ":start",
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
].join("\r\n");

function readerFor(files) {
  return (file) => {
    if (!(file in files)) throw new Error(`ENOENT: ${file}`);
    return files[file];
  };
}

test("an .exe on PATH wins over npm's extensionless and .cmd shims", () => {
  const where = [
    `${NPM_DIR}\\claude`,
    `${NPM_DIR}\\claude.cmd`,
    "C:\\Users\\me\\.local\\bin\\claude.exe",
  ].join("\r\n");

  assert.equal(
    pickWindowsExecutable(where, readerFor({})),
    "C:\\Users\\me\\.local\\bin\\claude.exe"
  );
});

test("an npm .cmd shim that launches a native binary resolves to that binary", () => {
  const where = [`${NPM_DIR}\\claude`, `${NPM_DIR}\\claude.cmd`].join("\r\n");
  const files = { [`${NPM_DIR}\\claude.cmd`]: NATIVE_SHIM };

  assert.equal(
    pickWindowsExecutable(where, readerFor(files)),
    path.win32.join(NPM_DIR, "node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe")
  );
});

test("a .cmd shim that runs a script, not a binary, is not spawnable", () => {
  const where = `${NPM_DIR}\\codex.cmd`;
  const files = { [`${NPM_DIR}\\codex.cmd`]: SCRIPT_SHIM };

  assert.equal(pickWindowsExecutable(where, readerFor(files)), null);
});

test("an unreadable .cmd shim is skipped rather than fatal", () => {
  assert.equal(pickWindowsExecutable(`${NPM_DIR}\\claude.cmd`, readerFor({})), null);
});

test("nothing on PATH resolves to nothing", () => {
  assert.equal(pickWindowsExecutable("", readerFor({})), null);
});
