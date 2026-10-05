const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// On Windows the paste-target probe spawns a helper process. The paste path
// waits out an in-flight probe itself, so the recording must not wait for it.
const FAKE_AUDIO_MANAGER_SOURCE = `
export default class FakeAudioManager {
  constructor() {
    this.voiceAgentRequested = false;
    this.translationRequested = false;
    this.sttConfig = { success: true };
  }
  setCallbacks(callbacks) { this.callbacks = callbacks; }
  getState() { return { isRecording: false, isProcessing: false, isStreaming: false }; }
  isSttConfigStale() { return false; }
  setSttConfig(config) { this.sttConfig = config; }
  shouldUseStreaming() { return false; }
  prepareMicCapture() {}
  setVoiceAgentRequested() {}
  setAssistantSelectionContext() {}
  setTranslationRequested() {}
  async startRecording() { globalThis.__targetProbeStarts += 1; return true; }
  cleanup() {}
}
`;

test("a recording starts while the paste-target probe is still running", async (t) => {
  let root = null;
  let start = null;
  globalThis.__targetProbeStarts = 0;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__targetProbeStarts;
  });

  const noopDispose = () => () => {};
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        onToggleDictation: noopDispose,
        onToggleVoiceAgent: noopDispose,
        onToggleTranslation: noopDispose,
        onStartDictation: (handler) => {
          start = handler;
          return () => {};
        },
        onPrepareDictation: noopDispose,
        onCancelDictationPreparation: noopDispose,
        onStopDictation: noopDispose,
        getSttConfig: async () => ({ success: true }),
        captureDictationTarget: () => new Promise(() => {}),
        completeDictationPreview: async () => {},
        hideDictationPreview: async () => {},
        dictationLifecycleStateChanged: () => {},
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-target-probe-hook-",
    mockModules: {
      "/helpers/audioManager": FAKE_AUDIO_MANAGER_SOURCE,
      "/utils/logger": "export default { debug() {}, info() {}, warn() {}, error() {} };",
    },
  });
  const { useAudioRecording } = await vite.ssrLoadModule("/hooks/useAudioRecording.js");

  function Harness() {
    useAudioRecording(() => {}, { onDemoEvent: () => {} });
    return null;
  }

  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  await React.act(async () => {
    start();
    // Two bounded visual-frame waits precede the mic open in the start path.
    await new Promise((resolve) => setTimeout(resolve, 700));
  });

  assert.equal(globalThis.__targetProbeStarts, 1);
});
