const test = require("node:test");
const assert = require("node:assert/strict");

const { ClaudeCodeAdapter } = require("../../src/helpers/cliAgent/claudeCodeAdapter");

const adapter = new ClaudeCodeAdapter();
const req = (o = {}) => ({
  prompt: "open a ticket",
  systemPrompt: "SYS",
  model: "",
  permissionMode: "auto",
  resumeSessionId: null,
  ...o,
});

test("buildArgs: defaults", () => {
  assert.deepEqual(adapter.buildArgs(req()), [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--settings",
    '{"disableAllHooks":true}',
    "--permission-mode",
    "auto",
    "--append-system-prompt",
    "SYS",
  ]);
});

test("a voice run skips the user's Claude Code hooks, which cost seconds at start and exit", () => {
  const args = adapter.buildArgs(req());
  assert.deepEqual(JSON.parse(args[args.indexOf("--settings") + 1]), { disableAllHooks: true });
});

test("the prompt is never on the command line, where a leading dash would read as an option", () => {
  assert.ok(!adapter.buildArgs(req({ prompt: "--version" })).includes("--version"));
});

test("the prompt goes to the CLI on stdin", () => {
  assert.equal(adapter.buildStdin(req({ prompt: "--version" })), "--version");
});

test("a run on the subscription login is allowed", () => {
  assert.equal(adapter.subscriptionProblem({ type: "init", apiKeySource: "none" }), null);
});

test("a run that would bill an API key is refused, naming its source", () => {
  assert.match(
    adapter.subscriptionProblem({ type: "init", apiKeySource: "ANTHROPIC_API_KEY" }),
    /API key \(ANTHROPIC_API_KEY\)/
  );
});

test("a run whose credential the CLI does not name is refused", () => {
  assert.ok(adapter.subscriptionProblem({ type: "init" }));
});

test("buildArgs: acceptEdits permission mode", () => {
  const args = adapter.buildArgs(req({ permissionMode: "acceptEdits" }));
  assert.equal(args[args.indexOf("--permission-mode") + 1], "acceptEdits");
});

test("buildArgs: model, resume, permission mapping", () => {
  const args = adapter.buildArgs(
    req({ model: "opus", permissionMode: "bypass", resumeSessionId: "s9" })
  );
  assert.ok(args.includes("--model") && args[args.indexOf("--model") + 1] === "opus");
  assert.ok(args.includes("--resume") && args[args.indexOf("--resume") + 1] === "s9");
  assert.equal(args[args.indexOf("--permission-mode") + 1], "bypassPermissions");
  assert.equal(
    adapter.buildArgs(req({ permissionMode: "manual" }))[
      adapter.buildArgs(req({ permissionMode: "manual" })).indexOf("--permission-mode") + 1
    ],
    "default"
  );
});

test("buildArgs: no system prompt flag when empty", () => {
  assert.ok(!adapter.buildArgs(req({ systemPrompt: "" })).includes("--append-system-prompt"));
});

test("mapEvent: system init carries the session and the credential it bills", () => {
  assert.deepEqual(
    adapter.mapEvent({ type: "system", subtype: "init", session_id: "abc", apiKeySource: "none" }),
    { type: "init", sessionId: "abc", apiKeySource: "none" }
  );
});

test("mapEvent: assistant tool_use blocks become stages", () => {
  const evt = {
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "thinking" },
        { type: "tool_use", name: "Bash", input: {} },
        { type: "tool_use", name: "mcp__jira__create_issue", input: {} },
        { type: "tool_use", name: "Skill", input: { command: "commit-message" } },
        { type: "tool_use", name: "Read", input: {} },
      ],
    },
  };
  assert.deepEqual(adapter.mapEvent(evt), [
    { type: "stage", label: { kind: "command" } },
    { type: "stage", label: { kind: "tool", name: "jira: create_issue" } },
    { type: "stage", label: { kind: "skill", name: "commit-message" } },
    { type: "stage", label: { kind: "tool", name: "Read" } },
  ]);
});

test("mapEvent: result", () => {
  assert.deepEqual(
    adapter.mapEvent({
      type: "result",
      result: "Done.",
      is_error: false,
      session_id: "abc",
      permission_denials: [{ tool_name: "Bash" }],
    }),
    [
      { type: "sessionId", sessionId: "abc" },
      { type: "result", text: "Done.", isError: false, permissionDenials: ["Bash"] },
    ]
  );
});

test("mapEvent: irrelevant events map to null", () => {
  assert.equal(adapter.mapEvent({ type: "user" }), null);
});

// Recorded from Claude Code 2.1.90: `--resume <unknown id>` reports on stdout, not stderr.
const UNKNOWN_SESSION_RESULT = {
  type: "result",
  subtype: "error_during_execution",
  is_error: true,
  errors: ["No conversation found with session ID: 0b5c2b52-6f3e-4c4e-9e07-1f0f6b0e5a11"],
};

test("an unknown-session result carries its reason as the error text", () => {
  const [result] = adapter.mapEvent(UNKNOWN_SESSION_RESULT);
  assert.equal(adapter.isUnknownSessionError(result.text), true);
});

test("isUnknownSessionError", () => {
  assert.equal(adapter.isUnknownSessionError("No conversation found with session ID s9"), true);
  assert.equal(adapter.isUnknownSessionError("rate limited"), false);
});
