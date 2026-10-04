const test = require("node:test");
const assert = require("node:assert/strict");

const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const CONFIG = { provider: "claude-code", systemPrompt: "Answer the user." };

async function loadReasoningService(t, cachePrefix, electronAPI) {
  installBrowserGlobals(t, { window: { electronAPI, dispatchEvent() {} } });
  const vite = await createRendererServer(t, { cachePrefix });
  const reasoningService = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", appVersion: "1.10.0", policy: null });
  t.after(() => reasoningService.destroy());
  return reasoningService;
}

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

test("a CLI agent turn answers the panel with the agent's final text", async (t) => {
  const reasoningService = await loadReasoningService(t, "openwhispr-cli-stream-answer-", {
    processCliAgent: async () => ({ success: true, text: "Done: the file is renamed." }),
  });

  const chunks = await collect(
    reasoningService.processTextStreamingCli("rename the file", "", CONFIG)
  );

  assert.deepEqual(chunks[0], { type: "content", text: "Done: the file is renamed." });
});

test("the CLI agent is asked with only the prompt it is given", async (t) => {
  const sent = [];
  const reasoningService = await loadReasoningService(t, "openwhispr-cli-stream-prompt-", {
    processCliAgent: async (opts) => {
      sent.push(opts);
      return { success: true, text: "ok" };
    },
  });

  await collect(reasoningService.processTextStreamingCli("what time is it", "", CONFIG));

  assert.equal(sent[0].prompt, "what time is it");
});

test("what the agent is doing reaches the caller while it works", async (t) => {
  let report;
  const reasoningService = await loadReasoningService(t, "openwhispr-cli-stream-stage-", {
    onCliAgentStage: (callback) => {
      report = callback;
      return () => {
        report = undefined;
      };
    },
    processCliAgent: async () => {
      report?.({ kind: "tool", name: "github: create_issue" });
      return { success: true, text: "ok" };
    },
  });
  const stages = [];

  await collect(
    reasoningService.processTextStreamingCli("file an issue", "", CONFIG, (s) => stages.push(s))
  );

  assert.deepEqual(stages, [{ kind: "tool", name: "github: create_issue" }]);
});

test("cancelling the panel's stream stops the CLI run", async (t) => {
  let cancelled = false;
  let finish;
  const reasoningService = await loadReasoningService(t, "openwhispr-cli-stream-cancel-", {
    processCliAgent: () =>
      new Promise((resolve) => {
        finish = () => resolve({ success: false, error: "CLI agent run cancelled" });
      }),
    cancelCliAgent: async () => {
      cancelled = true;
      finish();
      return { success: true };
    },
  });

  const run = collect(reasoningService.processTextStreamingCli("long task", "", CONFIG));
  await new Promise((resolve) => setImmediate(resolve));
  reasoningService.cancelActiveStream();
  await run.catch(() => {});

  assert.equal(cancelled, true);
});

test("a failed CLI run surfaces its error to the panel", async (t) => {
  const reasoningService = await loadReasoningService(t, "openwhispr-cli-stream-error-", {
    processCliAgent: async () => ({ success: false, error: "claude was not found on PATH" }),
  });

  await assert.rejects(
    collect(reasoningService.processTextStreamingCli("hello", "", CONFIG)),
    /claude was not found on PATH/
  );
});

test("cancelling a dictation stops a CLI agent run too", async (t) => {
  let cancelled = false;
  const reasoningService = await loadReasoningService(t, "openwhispr-cli-cancel-all-", {
    cancelCliAgent: async () => {
      cancelled = true;
      return { success: true };
    },
  });

  reasoningService.cancelAllRequests();

  assert.equal(cancelled, true);
});
