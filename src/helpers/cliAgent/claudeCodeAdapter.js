const { BaseCliAdapter } = require("./baseCliAdapter");

const PERMISSION_MODE_MAP = {
  manual: "default",
  auto: "auto",
  acceptEdits: "acceptEdits",
  bypass: "bypassPermissions",
};

class ClaudeCodeAdapter extends BaseCliAdapter {
  get id() {
    return "claude-code";
  }
  get binaryName() {
    return "claude";
  }

  // The prompt goes to stdin, never argv: `-p` takes no value, so a dictated
  // prompt starting with "-" would otherwise be parsed as an option.
  // The user's hooks (session start/end plugins and the like) are for their
  // coding sessions and add seconds to every spoken command, so a voice run
  // turns them off. `--bare` would too, but it ignores the subscription login.
  buildArgs(request) {
    const args = ["-p", "--output-format", "stream-json", "--verbose"];
    args.push("--settings", JSON.stringify({ disableAllHooks: true }));
    if (request.model) args.push("--model", request.model);
    args.push("--permission-mode", PERMISSION_MODE_MAP[request.permissionMode] || "acceptEdits");
    if (request.systemPrompt) args.push("--append-system-prompt", request.systemPrompt);
    if (request.resumeSessionId) args.push("--resume", request.resumeSessionId);
    return args;
  }

  buildStdin(request) {
    return request.prompt;
  }

  // Claude Code names the credential it will bill in its init event; "none"
  // is the subscription login. Anything else — a key from the environment,
  // settings.json, an apiKeyHelper or a Console login — would bill per token.
  subscriptionProblem(initEvent) {
    if (initEvent.apiKeySource === "none") return null;
    return (
      `Claude Code would bill an API key (${initEvent.apiKeySource ?? "unknown source"}) ` +
      "instead of your Claude subscription. Remove the key from Claude Code's settings and " +
      "log in with your Claude account (claude, then /login)."
    );
  }

  _stageForToolUse(block) {
    if (block.name === "Bash") return { type: "stage", label: { kind: "command" } };
    if (block.name === "Skill") {
      return { type: "stage", label: { kind: "skill", name: block.input?.command || "skill" } };
    }
    const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(block.name);
    if (mcp) return { type: "stage", label: { kind: "tool", name: `${mcp[1]}: ${mcp[2]}` } };
    return { type: "stage", label: { kind: "tool", name: block.name } };
  }

  mapEvent(json) {
    if (json.type === "system" && json.subtype === "init") {
      return { type: "init", sessionId: json.session_id || null, apiKeySource: json.apiKeySource };
    }
    if (json.type === "assistant") {
      const blocks = json.message?.content || [];
      const stages = blocks
        .filter((b) => b.type === "tool_use")
        .map((b) => this._stageForToolUse(b));
      return stages.length ? stages : null;
    }
    if (json.type === "result") {
      const events = [];
      if (json.session_id) events.push({ type: "sessionId", sessionId: json.session_id });
      events.push({
        type: "result",
        // An error result carries its reason in `errors`, not `result`.
        text: json.result || (json.errors || []).join("; "),
        isError: !!json.is_error,
        permissionDenials: (json.permission_denials || []).map((d) => d.tool_name || String(d)),
      });
      return events;
    }
    return null;
  }

  isUnknownSessionError(text) {
    return /no conversation found/i.test(text);
  }
}

module.exports = { ClaudeCodeAdapter };
