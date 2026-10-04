const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { BaseCliAdapter, CliAgentError } = require("../../src/helpers/cliAgent/baseCliAdapter");

class FakeChild extends EventEmitter {
  constructor({ pid } = {}) {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killed = false;
    this.exitCode = null;
    if (pid !== undefined) this.pid = pid;
  }
  kill() {
    this.killed = true;
    this.emit("close", null, "SIGKILL");
  }
}

// Minimal concrete adapter: events pass through pre-normalized under `evt`.
class EchoAdapter extends BaseCliAdapter {
  get id() {
    return "echo";
  }
  get binaryName() {
    return "echo-cli";
  }
  buildArgs() {
    return ["--x"];
  }
  mapEvent(json) {
    return json.evt || null;
  }
  isUnknownSessionError(stderr) {
    return stderr.includes("No conversation found");
  }
}

function baseRequest(overrides = {}) {
  return {
    commandPath: "/bin/echo-cli",
    prompt: "hi",
    systemPrompt: "",
    model: "",
    permissionMode: "auto",
    cwd: "/tmp",
    timeoutMs: 5000,
    resumeSessionId: null,
    ...overrides,
  };
}

test("parses line-buffered json, emits stages, resolves on result", async () => {
  const adapter = new EchoAdapter();
  let child;
  const stages = [];
  const promise = adapter.run(baseRequest(), {
    onEvent: (e) => {
      if (e.type === "stage") stages.push(e.label);
    },
    spawnFn: (cmd, args, opts) => {
      assert.equal(cmd, "/bin/echo-cli");
      assert.deepEqual(args, ["--x"]);
      assert.equal(opts.cwd, "/tmp");
      child = new FakeChild();
      return child;
    },
  });
  // split a line across chunks to prove buffering
  child.stdout.emit(
    "data",
    Buffer.from('{"evt":{"type":"init","sessionId":"s1"}}\n{"evt":{"type":"stage","la')
  );
  child.stdout.emit("data", Buffer.from('bel":{"kind":"command"}}}\n'));
  child.stdout.emit("data", Buffer.from("not json at all\n")); // skipped, not fatal
  child.stdout.emit(
    "data",
    Buffer.from(
      '{"evt":{"type":"result","text":"done","isError":false,"permissionDenials":["Bash"]}}\n'
    )
  );
  child.emit("close", 0);
  const res = await promise;
  assert.deepEqual(res, { text: "done", sessionId: "s1", permissionDenials: ["Bash"] });
  assert.deepEqual(stages, [{ kind: "command" }]);
});

test("rejects cli_error when result has isError", async () => {
  const adapter = new EchoAdapter();
  let child;
  const promise = adapter.run(baseRequest(), {
    spawnFn: () => (child = new FakeChild()),
  });
  child.stdout.emit(
    "data",
    Buffer.from('{"evt":{"type":"result","text":"boom","isError":true,"permissionDenials":[]}}\n')
  );
  child.emit("close", 1);
  await assert.rejects(promise, (e) => e instanceof CliAgentError && e.code === "cli_error");
});

test("rejects no_result when process exits without a result event", async () => {
  const adapter = new EchoAdapter();
  let child;
  const promise = adapter.run(baseRequest(), { spawnFn: () => (child = new FakeChild()) });
  child.stderr.emit("data", Buffer.from("something broke"));
  child.emit("close", 1);
  await assert.rejects(
    promise,
    (e) => e.code === "no_result" && e.stderr.includes("something broke")
  );
});

test("watchdog kills the child's process tree and rejects with timeout", async () => {
  const adapter = new EchoAdapter();
  let child;
  const kills = [];
  const promise = adapter.run(baseRequest({ timeoutMs: 10 }), {
    spawnFn: () => (child = new FakeChild()),
    killFn: (proc, signal) => kills.push({ proc, signal }),
  });
  await assert.rejects(promise, (e) => e.code === "timeout");
  assert.deepEqual(kills, [{ proc: child, signal: "SIGKILL" }]);
});

test("abort signal kills the child's process tree and rejects with cancelled", async () => {
  const adapter = new EchoAdapter();
  const controller = new AbortController();
  let child;
  const kills = [];
  const promise = adapter.run(baseRequest(), {
    signal: controller.signal,
    spawnFn: () => (child = new FakeChild()),
    killFn: (proc, signal) => kills.push({ proc, signal }),
  });
  controller.abort();
  await assert.rejects(promise, (e) => e.code === "cancelled");
  assert.deepEqual(kills, [{ proc: child, signal: "SIGKILL" }]);
});

test("spawn error rejects with spawn code", async () => {
  const adapter = new EchoAdapter();
  let child;
  const promise = adapter.run(baseRequest(), { spawnFn: () => (child = new FakeChild()) });
  child.emit("error", new Error("ENOENT"));
  await assert.rejects(promise, (e) => e.code === "spawn");
});

test("spawn env excludes secrets but keeps normal vars, and sets platform-correct detached", async () => {
  const originalKey = process.env.OPENAI_API_KEY;
  const originalNormal = process.env.OPENWHISPR_TEST_NORMAL_VAR;
  process.env.OPENAI_API_KEY = "sk-secret";
  process.env.OPENWHISPR_TEST_NORMAL_VAR = "keep-me";
  try {
    const adapter = new EchoAdapter();
    let child;
    let capturedOpts;
    const promise = adapter.run(baseRequest(), {
      spawnFn: (cmd, args, opts) => {
        capturedOpts = opts;
        child = new FakeChild();
        return child;
      },
    });
    child.stdout.emit(
      "data",
      Buffer.from(
        '{"evt":{"type":"result","text":"done","isError":false,"permissionDenials":[]}}\n'
      )
    );
    child.emit("close", 0);
    await promise;

    assert.equal(capturedOpts.env.OPENAI_API_KEY, undefined);
    assert.equal(capturedOpts.env.OPENWHISPR_TEST_NORMAL_VAR, "keep-me");
    assert.equal(capturedOpts.detached, process.platform !== "win32");
  } finally {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    if (originalNormal === undefined) delete process.env.OPENWHISPR_TEST_NORMAL_VAR;
    else process.env.OPENWHISPR_TEST_NORMAL_VAR = originalNormal;
  }
});

// Process groups are POSIX; Windows kills the tree with taskkill instead.
test(
  "watchdog kill falls back to direct kill when group signal fails",
  {
    skip: process.platform === "win32" && "process groups exist only on POSIX",
  },
  async () => {
    const adapter = new EchoAdapter();
    let child;
    // A pid whose process group doesn't exist: process.kill(-pid) throws,
    // exercising the fallback to child.kill().
    const promise = adapter.run(baseRequest({ timeoutMs: 10 }), {
      spawnFn: () => (child = new FakeChild({ pid: 2 ** 30 })),
    });
    await assert.rejects(promise, (e) => e.code === "timeout");
    assert.equal(child.killed, true);
  }
);

// Each of these would move a CLI off the user's subscription login: onto a
// metered key, another endpoint, or a cloud provider's billing.
for (const key of [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
]) {
  test(`spawn env drops ${key} inherited from the app's environment`, async () => {
    const original = process.env[key];
    process.env[key] = "inherited";
    try {
      const adapter = new EchoAdapter();
      let child;
      let capturedOpts;
      const promise = adapter.run(baseRequest(), {
        spawnFn: (cmd, args, opts) => {
          capturedOpts = opts;
          child = new FakeChild();
          return child;
        },
      });
      child.stdout.emit(
        "data",
        Buffer.from(
          '{"evt":{"type":"result","text":"done","isError":false,"permissionDenials":[]}}\n'
        )
      );
      child.emit("close", 0);
      await promise;

      assert.equal(capturedOpts.env[key], undefined);
    } finally {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  });
}

test("a prompt the adapter sends on stdin reaches the CLI whole", async () => {
  class StdinAdapter extends EchoAdapter {
    buildStdin(request) {
      return request.prompt;
    }
  }
  let written = null;
  let child;
  const promise = new StdinAdapter().run(baseRequest({ prompt: "--version" }), {
    spawnFn: () => {
      child = new FakeChild();
      child.stdin = { on() {}, end: (text) => (written = text) };
      return child;
    },
  });
  child.stdout.emit(
    "data",
    Buffer.from('{"evt":{"type":"result","text":"ok","isError":false,"permissionDenials":[]}}\n')
  );
  child.emit("close", 0);
  await promise;

  assert.equal(written, "--version");
});

test("a character split across two output chunks is decoded whole", async () => {
  const adapter = new EchoAdapter();
  let child;
  const promise = adapter.run(baseRequest(), {
    spawnFn: () => {
      child = new FakeChild();
      const { StringDecoder } = require("node:string_decoder");
      for (const stream of [child.stdout, child.stderr]) {
        const decoder = new StringDecoder("utf8");
        const emit = stream.emit.bind(stream);
        stream.setEncoding = () => {
          stream.emit = (name, chunk) =>
            name === "data" ? emit(name, decoder.write(chunk)) : emit(name, chunk);
        };
      }
      return child;
    },
  });
  const line = Buffer.from(
    '{"evt":{"type":"result","text":"日本","isError":false,"permissionDenials":[]}}\n'
  );
  const cut = line.indexOf(Buffer.from("日")) + 1; // inside the first character
  child.stdout.emit("data", line.subarray(0, cut));
  child.stdout.emit("data", line.subarray(cut));
  child.emit("close", 0);

  assert.equal((await promise).text, "日本");
});

test("a run whose init event the adapter refuses is killed before it does anything", async () => {
  class GuardedAdapter extends EchoAdapter {
    subscriptionProblem() {
      return "would bill an API key";
    }
  }
  let child;
  const kills = [];
  const promise = new GuardedAdapter().run(baseRequest(), {
    spawnFn: () => (child = new FakeChild()),
    killFn: (proc) => kills.push(proc),
  });
  child.stdout.emit("data", Buffer.from('{"evt":{"type":"init","sessionId":"s1"}}\n'));

  await assert.rejects(promise, (e) => e.code === "not_subscription");
  assert.deepEqual(kills, [child]);
});

test("spawn env drops a secret whatever its case, as Windows reads it", async () => {
  process.env.anthropic_api_key = "inherited";
  try {
    const adapter = new EchoAdapter();
    let child;
    let capturedOpts;
    const promise = adapter.run(baseRequest(), {
      spawnFn: (cmd, args, opts) => {
        capturedOpts = opts;
        child = new FakeChild();
        return child;
      },
    });
    child.stdout.emit(
      "data",
      Buffer.from(
        '{"evt":{"type":"result","text":"done","isError":false,"permissionDenials":[]}}\n'
      )
    );
    child.emit("close", 0);
    await promise;

    assert.equal(
      Object.keys(capturedOpts.env).some((k) => k.toUpperCase() === "ANTHROPIC_API_KEY"),
      false
    );
  } finally {
    delete process.env.anthropic_api_key;
  }
});

test("a CLI that exits without a result says why, from its stderr", async () => {
  const adapter = new EchoAdapter();
  let child;
  const promise = adapter.run(baseRequest(), { spawnFn: () => (child = new FakeChild()) });
  child.stderr.emit("data", Buffer.from("Invalid API key\n"));
  child.emit("close", 1);

  await assert.rejects(promise, /Invalid API key/);
});
