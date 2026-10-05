const fs = require("fs");
const os = require("os");
const { execFile } = require("child_process");
const { CliAgentSessionStore } = require("./sessionStore");
const { CliAgentError } = require("./baseCliAdapter");
const { ClaudeCodeAdapter } = require("./claudeCodeAdapter");
const { CodexAdapter } = require("./codexAdapter");
const debugLogger = require("../debugLogger");
const { pickWindowsExecutable } = require("./windowsBinary");

const CLI_CHANNEL_PROMPT = [
  "The user's message was dictated by voice and transcribed automatically, so read",
  "through transcription errors for the intended meaning. Your final answer will be",
  "pasted directly into whatever window the user is working in: reply with short,",
  "plain prose only - no markdown, no headings, no code fences unless the user",
  "explicitly asked for code. Use your available tools to actually perform the task",
  "rather than describing how to do it.",
].join(" ");

const DEFAULT_ADAPTER_FACTORIES = {
  "claude-code": () => new ClaudeCodeAdapter(),
  codex: () => new CodexAdapter(),
};

// GUI-launched Electron on macOS/Linux lacks the user's shell PATH; resolve
// through a login shell. Cached per binary name.
function defaultResolveBinary(binaryName) {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      execFile("where", [binaryName], { windowsHide: true }, (err, stdout) =>
        resolve(err ? null : pickWindowsExecutable(stdout, (f) => fs.readFileSync(f, "utf8")))
      );
      return;
    }
    const shell = process.env.SHELL || "/bin/sh";
    execFile(shell, ["-lc", `command -v ${binaryName}`], (err, stdout) =>
      resolve(err ? null : stdout.trim() || null)
    );
  });
}

// Past 2^31-1 ms Node fires a timer after 1 ms, so a huge setting would fail
// every run at once; an hour is longer than any spoken command needs.
const MAX_TIMEOUT_SECONDS = 3600;
function clampTimeoutSeconds(seconds) {
  if (!(seconds > 0)) return 240;
  return Math.min(seconds, MAX_TIMEOUT_SECONDS);
}

class CliAgentManager {
  constructor({ sessionFilePath, sendStage, adapterFactories, resolveBinary }) {
    this.sessionStore = new CliAgentSessionStore(sessionFilePath);
    this.sendStage = sendStage || (() => {});
    this.adapterFactories = adapterFactories || DEFAULT_ADAPTER_FACTORIES;
    this.resolveBinary = resolveBinary || defaultResolveBinary;
    this._binaryCache = new Map();
    this._current = null;
  }

  async _binaryFor(cli) {
    if (this._binaryCache.has(cli)) return this._binaryCache.get(cli);
    const factory = this.adapterFactories[cli];
    if (!factory) return null;
    const found = await this.resolveBinary(factory().binaryName);
    if (found) this._binaryCache.set(cli, found);
    return found;
  }

  async check(cli) {
    const p = await this._binaryFor(cli);
    return { available: !!p, path: p };
  }

  cancel() {
    this._current?.controller.abort();
    this._current = null;
  }

  async run(opts) {
    this.cancel();
    const controller = new AbortController();
    this._current = { controller };

    const commandPath = await this._binaryFor(opts.cli);
    if (!commandPath) {
      throw new CliAgentError(
        `${this.adapterFactories[opts.cli]?.().binaryName ?? opts.cli} was not found on PATH`,
        "cli_not_found"
      );
    }

    const systemPrompt = [opts.systemPrompt, CLI_CHANNEL_PROMPT, opts.extraPrompt]
      .filter((s) => s && s.trim())
      .join("\n\n");
    // A window of 0 is a one-off run: it must not take over the session the
    // panel's conversation resumes.
    const sessionMinutes = Math.max(0, opts.sessionMinutes ?? 30);
    const baseRequest = {
      commandPath,
      prompt: opts.prompt,
      systemPrompt,
      model: opts.model || "",
      permissionMode: opts.permissionMode || "auto",
      cwd: opts.workingDir?.trim() || os.homedir(),
      timeoutMs: clampTimeoutSeconds(opts.timeoutSeconds) * 1000,
      resumeSessionId: this.sessionStore.get(opts.cli, sessionMinutes),
    };

    try {
      // Simple prompts may produce no tool events at all — show something
      // from the moment the CLI starts.
      this.sendStage({ kind: "thinking" });
      const result = await this._attempt(opts.cli, baseRequest, controller.signal, true);
      if (result.sessionId && sessionMinutes > 0) this.sessionStore.set(opts.cli, result.sessionId);
      return result;
    } finally {
      if (this._current?.controller === controller) this._current = null;
    }
  }

  async _attempt(cli, request, signal, allowSessionRetry) {
    const adapter = this.adapterFactories[cli]();
    try {
      return await adapter.run(request, {
        signal,
        onEvent: (evt) => {
          if (evt.type === "stage") this.sendStage(evt.label);
        },
      });
    } catch (err) {
      const staleSession =
        allowSessionRetry &&
        request.resumeSessionId &&
        err instanceof CliAgentError &&
        err.code !== "cancelled" &&
        // Claude Code reports an unknown session in its result event, Codex on stderr.
        adapter.isUnknownSessionError(`${err.message}\n${err.stderr || ""}`);
      if (!staleSession) throw err;
      debugLogger.debug("cli-agent: stale session, retrying without resume", { cli }, "cli-agent");
      this.sessionStore.clear(cli);
      return this._attempt(cli, { ...request, resumeSessionId: null }, signal, false);
    }
  }
}

module.exports = { CliAgentManager, CLI_CHANNEL_PROMPT };
