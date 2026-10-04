const { spawn } = require("child_process");
const { SECRET_ENV_KEYS } = require("../../config/secretKeys");
const { killProcessGroup } = require("../../utils/process");

// Variables that move Claude Code off the subscription login even when the app
// never stored them: inherited from the user's environment, they would point
// it at a metered key, another endpoint, or a cloud provider's billing.
const SUBSCRIPTION_OVERRIDE_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];

const STRIPPED_KEYS = new Set(
  [...SECRET_ENV_KEYS, ...SUBSCRIPTION_OVERRIDE_KEYS].map((key) => key.toUpperCase())
);

// Strip BYOK/enterprise secrets so they never leak into the CLI's env — e.g.
// Claude Code prefers ANTHROPIC_API_KEY over subscription auth when present.
// Matched without case: Windows environment names are case-insensitive, but a
// copied process.env is a plain object whose keys are not.
function buildChildEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (STRIPPED_KEYS.has(key.toUpperCase())) delete env[key];
  }
  return env;
}

// The end of what the CLI wrote to stderr, for an error message a user can act on.
function stderrTail(stderrText) {
  const tail = stderrText.trim().split(/\r?\n/).slice(-3).join(" ").trim();
  return tail ? `: ${tail.slice(0, 500)}` : "";
}

class CliAgentError extends Error {
  constructor(message, code, stderr = "") {
    super(message);
    this.name = "CliAgentError";
    this.code = code;
    this.stderr = stderr;
  }
}

class BaseCliAdapter {
  // Subclasses implement: get id(), get binaryName(), buildArgs(request),
  // mapEvent(json), isUnknownSessionError(text). They may implement
  // buildStdin(request), whose text is written to the CLI's stdin, and
  // subscriptionProblem(initEvent), which stops the run before it bills
  // anything but the user's subscription.

  run(request, { onEvent = () => {}, signal, spawnFn = spawn, killFn = killProcessGroup } = {}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let stderrText = "";
      let lineBuffer = "";
      let sessionId = request.resumeSessionId || null;
      let result = null;
      let timeoutHandle = null;
      const stdinText = this.buildStdin?.(request) ?? null;

      const child = spawnFn(request.commandPath, this.buildArgs(request), {
        cwd: request.cwd,
        env: buildChildEnv(),
        stdio: [stdinText === null ? "ignore" : "pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });

      // Kill the whole process group (bash/MCP subprocesses the agent spawned),
      // not just the direct child, since child is spawned detached on non-Windows.
      const killChild = () => killFn(child, "SIGKILL");

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        if (signal) signal.removeEventListener("abort", onAbort);
        child.stdout.removeListener("data", onStdoutData);
        child.stderr.removeListener("data", onStderrData);
        fn(value);
      };

      const killAndReject = (code, message) => {
        finish(reject, new CliAgentError(message, code, stderrText));
        killChild();
      };

      const onAbort = () => killAndReject("cancelled", "CLI agent run cancelled");
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
      }

      timeoutHandle = setTimeout(
        () => killAndReject("timeout", `CLI agent timed out after ${request.timeoutMs}ms`),
        request.timeoutMs
      );
      timeoutHandle.unref?.();

      const handleNormalized = (evt) => {
        if (!evt || settled) return;
        if (Array.isArray(evt)) return evt.forEach(handleNormalized);
        if (evt.type === "init") {
          const problem = this.subscriptionProblem?.(evt);
          if (problem) return killAndReject("not_subscription", problem);
          if (evt.sessionId) sessionId = evt.sessionId;
        } else if (evt.type === "sessionId") sessionId = evt.sessionId;
        else if (evt.type === "result") result = evt;
        onEvent(evt);
      };

      const consumeLine = (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let json;
        try {
          json = JSON.parse(trimmed);
        } catch {
          return; // non-JSON noise is never fatal
        }
        handleNormalized(this.mapEvent(json));
      };

      // Decoded as one stream, so a multi-byte character split across two
      // chunks is not turned into replacement characters.
      child.stdout.setEncoding?.("utf8");
      child.stderr.setEncoding?.("utf8");
      const onStdoutData = (chunk) => {
        lineBuffer += chunk.toString();
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop();
        lines.forEach(consumeLine);
      };
      const onStderrData = (chunk) => {
        stderrText += chunk.toString();
      };
      child.stdout.on("data", onStdoutData);
      child.stderr.on("data", onStderrData);
      child.on("error", (err) =>
        finish(reject, new CliAgentError(err.message, "spawn", stderrText))
      );
      child.on("close", () => {
        if (lineBuffer) consumeLine(lineBuffer);
        if (!result) {
          return finish(
            reject,
            new CliAgentError(
              `CLI exited without a result event${stderrTail(stderrText)}`,
              "no_result",
              stderrText
            )
          );
        }
        if (result.isError) {
          return finish(
            reject,
            new CliAgentError(result.text || "CLI agent reported an error", "cli_error", stderrText)
          );
        }
        finish(resolve, {
          text: result.text,
          sessionId,
          permissionDenials: result.permissionDenials || [],
        });
      });

      if (stdinText !== null) {
        child.stdin.on("error", () => {}); // a CLI that exits early closes the pipe; close reports it
        child.stdin.end(stdinText);
      }
    });
  }
}

module.exports = { BaseCliAdapter, CliAgentError };
