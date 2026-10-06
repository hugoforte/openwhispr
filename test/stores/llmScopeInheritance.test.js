const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// A scope with no model of its own borrows its fallback scope's. A model belongs
// to the route it was chosen on, so the borrow only holds within one mode.

const LAN_CLEANUP = {
  _llmScopeKeysMigrated: "1",
  _dictationAgentSeeded: "1",
  cleanupMode: "self-hosted",
  cleanupProvider: "lan",
  cleanupModel: "claude-haiku-4-5-20251001",
  cleanupRemoteUrl: "https://lan.example:8317/v1",
};

async function loadStore(t, initialStorage, cachePrefix) {
  installBrowserGlobals(t, { initialStorage });
  const vite = await createRendererServer(t, {
    cachePrefix,
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
  });
  await vite.ssrLoadModule("/models/ModelRegistry.ts");
  return vite.ssrLoadModule("/stores/settingsStore.ts");
}

test("local note formatting does not borrow a self-hosted cleanup model", async (t) => {
  const s = await loadStore(
    t,
    { ...LAN_CLEANUP, noteFormattingMode: "local" },
    "openwhispr-llm-scope-inheritance-local-test-"
  );

  const notes = s.selectResolvedNoteFormatting(s.useSettingsStore.getState());

  assert.deepEqual({ provider: notes.provider, model: notes.model }, { provider: "", model: "" });
});

test("self-hosted note formatting borrows the self-hosted cleanup model", async (t) => {
  const s = await loadStore(
    t,
    { ...LAN_CLEANUP, noteFormattingMode: "self-hosted" },
    "openwhispr-llm-scope-inheritance-same-mode-test-"
  );

  const notes = s.selectResolvedNoteFormatting(s.useSettingsStore.getState());

  assert.equal(notes.model, "claude-haiku-4-5-20251001");
});

test("signed-out cloud note formatting keeps following the cleanup model", async (t) => {
  const s = await loadStore(
    t,
    { ...LAN_CLEANUP, noteFormattingMode: "openwhispr", noteFormattingCloudMode: "byok" },
    "openwhispr-llm-scope-inheritance-cloud-test-"
  );

  const notes = s.selectResolvedNoteFormatting(s.useSettingsStore.getState());

  assert.equal(notes.model, "claude-haiku-4-5-20251001");
});
