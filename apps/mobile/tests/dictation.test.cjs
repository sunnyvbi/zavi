const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(
  path.join(__dirname, "../src/features/voice/useDictation.ts"),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function clock() {
  let now = 0;
  let nextId = 0;
  const tasks = new Map();
  return {
    setTimeout(fn, delay) {
      const id = ++nextId;
      tasks.set(id, { fn, at: now + delay });
      return id;
    },
    clearTimeout(id) { tasks.delete(id); },
    advance(duration) {
      const until = now + duration;
      let steps = 0;
      while (true) {
        const next = [...tasks].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > until) break;
        assert.ok(++steps < 100, "Timer cleanup must finish without an endless loop");
        tasks.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = until;
    },
    get size() { return tasks.size; },
  };
}

function speechService() {
  const listeners = new Map();
  const service = {
    available: true,
    state: "inactive",
    permission: { granted: true, canAskAgain: true },
    currentPermission: { granted: false, canAskAgain: true, status: "undetermined" },
    calls: { start: [], stop: 0, abort: 0, permissions: 0 },
    permissionRequest: null,
    stateRequest: null,
    isRecognitionAvailable() { return service.available; },
    async getStateAsync() {
      return service.stateRequest ? service.stateRequest() : service.state;
    },
    async requestPermissionsAsync() {
      service.calls.permissions += 1;
      return service.permissionRequest ? service.permissionRequest() : service.permission;
    },
    async getPermissionsAsync() { return service.currentPermission; },
    addListener(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(listener);
      return { remove: () => listeners.get(name).delete(listener) };
    },
    start(options) {
      service.calls.start.push(options);
      service.state = "starting";
    },
    stop() {
      service.calls.stop += 1;
      service.state = "stopping";
    },
    abort() {
      service.calls.abort += 1;
      service.state = "stopping";
    },
    emit(name, event = null) {
      if (name === "start") service.state = "recognizing";
      if (name === "end") service.state = "inactive";
      for (const listener of [...(listeners.get(name) || [])]) listener(event);
    },
    savedListeners(name) { return [...(listeners.get(name) || [])]; },
    listenerCount() {
      return [...listeners.values()].reduce((count, group) => count + group.size, 0);
    },
  };
  return service;
}

function mount({ service = speechService(), scopeKey = "workspace:thread-one", locale = "en-IN" } = {}) {
  const timers = clock();
  const slots = [];
  const appListeners = new Set();
  const confirmed = [];
  const settings = [];
  let cursor = 0;
  let dirty = true;
  let disposed = false;
  let layoutEffects = [];
  let effects = [];
  let current;
  let options = { scopeKey, enabled: true, onConfirm: (text) => confirmed.push(text) };
  const sameDeps = (before, after) => before && after &&
    before.length === after.length && before.every((item, index) => Object.is(item, after[index]));

  function effect(queue, callback, deps) {
    const index = cursor++;
    const previous = slots[index];
    if (previous && sameDeps(previous.deps, deps)) return;
    const slot = { deps, cleanup: previous?.cleanup };
    slots[index] = slot;
    queue.push(() => {
      slot.cleanup?.();
      slot.cleanup = callback();
    });
  }

  const react = {
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) {
        const slot = { value: typeof initial === "function" ? initial() : initial };
        slot.set = (next) => {
          assert.equal(disposed, false, "The hook must not update an unmounted screen");
          const value = typeof next === "function" ? next(slot.value) : next;
          if (!Object.is(value, slot.value)) { slot.value = value; dirty = true; }
        };
        slots[index] = slot;
      }
      return [slots[index].value, slots[index].set];
    },
    useRef(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { current: initial };
      return slots[index];
    },
    useCallback(callback, deps) {
      const index = cursor++;
      if (!slots[index] || !sameDeps(slots[index].deps, deps)) {
        slots[index] = { callback, deps };
      }
      return slots[index].callback;
    },
    useLayoutEffect(callback, deps) { effect(layoutEffects, callback, deps); },
    useEffect(callback, deps) { effect(effects, callback, deps); },
  };
  const appState = {
    currentState: "active",
    addEventListener(name, listener) {
      assert.equal(name, "change");
      appListeners.add(listener);
      return { remove: () => appListeners.delete(listener) };
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module,
    exports: module.exports,
    require(name) {
      if (name === "react") return react;
      if (name === "react-native") return {
        AppState: appState,
        Platform: { OS: "android" },
        Linking: { openSettings: async () => { settings.push(true); } },
      };
      if (name === "expo-speech-recognition") return { ExpoSpeechRecognitionModule: service };
      throw new Error(`Unexpected dependency: ${name}`);
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    Intl: { DateTimeFormat: () => ({ resolvedOptions: () => ({ locale }) }) },
  }, { filename: "useDictation.js" });

  function render() {
    let passes = 0;
    while (dirty && !disposed) {
      assert.ok(++passes < 30, "Hook renders must settle");
      cursor = 0;
      dirty = false;
      layoutEffects = [];
      effects = [];
      current = module.exports.useDictation(options);
      layoutEffects.forEach((run) => run());
      effects.forEach((run) => run());
    }
    return current;
  }
  return {
    service,
    confirmed,
    settings,
    timers,
    get api() { return render(); },
    update(patch) { options = { ...options, ...patch }; dirty = true; render(); },
    appState(next) {
      appState.currentState = next;
      for (const listener of [...appListeners]) listener(next);
      render();
    },
    emit(name, event) { service.emit(name, event); render(); },
    result(text, isFinal = false) {
      service.emit("result", { isFinal, results: [{ transcript: text }] });
      render();
    },
    unmount() {
      for (const slot of slots) slot?.cleanup?.();
      disposed = true;
    },
  };
}

async function listen(harness) {
  await harness.api.start();
  harness.emit("start");
  assert.equal(harness.api.phase, "listening");
}

test("dictation previews full phrases and completed segments without changing the draft", async () => {
  const h = mount();
  await listen(h);
  h.result("Find");
  h.result("Find new customers", true);
  h.result("in");
  h.result("in London");
  assert.equal(h.api.transcript, "Find new customers in London");
  assert.deepEqual(h.confirmed, []);
  assert.equal(h.service.calls.start[0].recordingOptions, undefined);
  assert.equal(h.service.calls.start[0].lang, "en-IN");
  h.api.cancel();
  h.emit("end");
});

test("confirm waits for the last native result and end, then delivers text exactly once", async () => {
  const h = mount();
  await listen(h);
  h.result("Draft an");
  h.api.confirm();
  h.api.confirm();
  assert.equal(h.api.phase, "stopping");
  assert.equal(h.service.calls.stop, 1);
  assert.deepEqual(h.confirmed, []);
  h.result("Draft an article", true);
  assert.deepEqual(h.confirmed, []);
  const oldEnd = h.service.savedListeners("end")[0];
  h.emit("end");
  oldEnd(null);
  h.api.confirm();
  assert.deepEqual(h.confirmed, ["Draft an article"]);
  assert.equal(h.api.phase, "idle");
  assert.equal(h.timers.size, 0);
});

test("natural recognition end retains words for review until confirmation", async () => {
  const h = mount();
  await listen(h);
  h.result("What needs my attention", true);
  h.emit("end");
  assert.equal(h.api.phase, "review");
  assert.equal(h.api.transcript, "What needs my attention");
  assert.deepEqual(h.confirmed, []);
  h.api.confirm();
  assert.deepEqual(h.confirmed, ["What needs my attention"]);
  assert.equal(h.api.phase, "idle");
});

test("cancel discards words and old callbacks cannot change a later session", async () => {
  const h = mount();
  await listen(h);
  h.result("Discard this");
  const oldResult = h.service.savedListeners("result")[0];
  const oldEnd = h.service.savedListeners("end")[0];
  h.api.cancel();
  h.result("Discard this too", true);
  h.emit("error", { error: "aborted" });
  assert.equal(h.api.transcript, "");
  assert.equal(h.api.error, null);
  h.emit("end");
  await listen(h);
  h.result("Keep this");
  oldResult({ isFinal: true, results: [{ transcript: "Old words" }] });
  oldEnd(null);
  assert.equal(h.api.phase, "listening");
  assert.equal(h.api.transcript, "Keep this");
  assert.deepEqual(h.confirmed, []);
  h.api.cancel();
  h.emit("end");
});

for (const change of ["cancel", "scope", "focus", "inactive", "unmount"]) {
  test(`permission resolving after ${change} never starts a cancelled recording`, async () => {
    const h = mount();
    const permission = deferred();
    const requested = deferred();
    h.service.permissionRequest = () => {
      requested.resolve();
      return permission.promise;
    };
    const pending = h.api.start();
    await requested.promise;
    assert.equal(h.service.calls.permissions, 1);
    if (change === "cancel") h.api.cancel();
    if (change === "scope") h.update({ scopeKey: "workspace:thread-two" });
    if (change === "focus") h.update({ enabled: false });
    if (change === "inactive") h.appState("inactive");
    if (change === "unmount") h.unmount();
    permission.resolve({ granted: true, canAskAgain: true });
    await pending;
    assert.equal(h.service.calls.start.length, 0);
    assert.deepEqual(h.confirmed, []);
    if (change !== "unmount") assert.equal(h.api.phase, "idle");
  });
}

test("an inactive app while native availability resolves returns to idle", async () => {
  const h = mount();
  const state = deferred();
  h.service.stateRequest = () => state.promise;
  const pending = h.api.start();
  h.appState("inactive");
  state.resolve("inactive");
  await pending;
  assert.equal(h.api.phase, "idle");
  assert.equal(h.service.calls.start.length, 0);
});

test("an old permission answer cannot cancel a new recording", async () => {
  const h = mount();
  const permission = deferred();
  const requested = deferred();
  h.service.permissionRequest = () => {
    requested.resolve();
    return permission.promise;
  };
  const oldStart = h.api.start();
  await requested.promise;
  h.api.cancel();
  h.service.permissionRequest = null;
  await listen(h);
  h.result("The current recording");
  permission.resolve({ granted: true, canAskAgain: true });
  await oldStart;
  assert.equal(h.api.phase, "listening");
  assert.equal(h.api.transcript, "The current recording");
  assert.equal(h.service.calls.start.length, 1);
  h.api.cancel();
  h.emit("end");
});

for (const change of ["background", "focus", "scope"]) {
  test(`${change} discards an active recording and its pending confirmation`, async () => {
    const h = mount();
    await listen(h);
    h.result("Private draft");
    h.api.confirm();
    if (change === "background") h.appState("background");
    if (change === "focus") h.update({ enabled: false });
    if (change === "scope") h.update({ scopeKey: "another-workspace:thread" });
    assert.equal(h.service.calls.abort, 1);
    h.result("Private draft finalized", true);
    h.emit("end");
    assert.equal(h.api.phase, "idle");
    assert.equal(h.api.transcript, "");
    assert.deepEqual(h.confirmed, []);
  });
}

test("permanent permission denial offers Settings, and granting access allows retry", async () => {
  const h = mount();
  h.service.permission = { granted: false, canAskAgain: false };
  await h.api.start();
  assert.equal(h.api.phase, "idle");
  assert.equal(h.api.canOpenSettings, true);
  assert.match(h.api.error, /settings/i);
  assert.equal(h.service.calls.start.length, 0);
  h.service.permission = { granted: true, canAskAgain: true };
  await listen(h);
  assert.equal(h.api.canOpenSettings, false);
  assert.equal(h.api.error, null);
  h.api.cancel();
  h.emit("end");
});

test("double tapping the microphone asks permission and starts recognition once", async () => {
  const h = mount();
  await Promise.all([h.api.start(), h.api.start()]);
  assert.equal(h.service.calls.permissions, 1);
  assert.equal(h.service.calls.start.length, 1);
  h.api.cancel();
  h.emit("end");
});

test("a speech recognition error leaves a useful message and allows another attempt", async () => {
  const h = mount();
  await listen(h);
  h.emit("error", { error: "network" });
  h.emit("end");
  assert.equal(h.api.phase, "idle");
  assert.match(h.api.error, /connection/i);
  assert.deepEqual(h.confirmed, []);
  await listen(h);
  assert.equal(h.api.error, null);
  h.api.cancel();
  h.emit("end");
});

test("silence returns to idle without adding empty text", async () => {
  const h = mount();
  await listen(h);
  h.emit("error", { error: "no-speech" });
  h.emit("end");
  assert.equal(h.api.phase, "idle");
  assert.match(h.api.error, /speech/i);
  assert.deepEqual(h.confirmed, []);
});

test("unavailable recognition leaves typing available without asking for permissions", async () => {
  const h = mount();
  h.service.available = false;
  await h.api.start();
  assert.equal(h.api.phase, "idle");
  assert.match(h.api.error, /unavailable/i);
  assert.equal(h.service.calls.permissions, 0);
});

test("a missing stop acknowledgement times out into recoverable review without confirmation", async () => {
  const h = mount();
  await listen(h);
  h.result("Keep my captured words");
  h.api.confirm();
  h.timers.advance(30000);
  assert.equal(h.api.phase, "review");
  assert.equal(h.api.transcript, "Keep my captured words");
  assert.ok(h.api.error);
  assert.equal(h.service.calls.abort, 1);
  assert.deepEqual(h.confirmed, []);
  assert.equal(h.timers.size, 0);
  h.api.confirm();
  assert.deepEqual(h.confirmed, ["Keep my captured words"]);
});

test("cancel recovers even when native end is absent and blocks a still-busy recognizer", async () => {
  const h = mount();
  await listen(h);
  h.api.cancel();
  h.timers.advance(30000);
  assert.equal(h.api.phase, "idle");
  await h.api.start();
  assert.equal(h.api.phase, "idle");
  assert.equal(h.service.calls.start.length, 1);
  h.emit("end");
  await listen(h);
  assert.equal(h.service.calls.start.length, 2);
  h.api.cancel();
  h.emit("end");
});

test("unmount releases listeners and a new screen waits for the old service to end", async () => {
  const service = speechService();
  const first = mount({ service });
  await listen(first);
  first.result("Old screen words");
  const oldEnd = service.savedListeners("end")[0];
  first.unmount();
  assert.equal(service.calls.abort, 1);
  assert.equal(service.listenerCount(), 0);
  const next = mount({ service, scopeKey: "workspace:thread-two" });
  await next.api.start();
  assert.equal(next.api.phase, "idle");
  assert.equal(service.calls.start.length, 1);
  service.emit("end");
  await listen(next);
  next.result("New screen words");
  oldEnd(null);
  assert.equal(next.api.transcript, "New screen words");
  assert.deepEqual(first.confirmed, []);
  assert.deepEqual(next.confirmed, []);
  next.unmount();
  assert.equal(service.listenerCount(), 0);
});

async function waitForDialog(h, mode) {
  for (let i = 0; i < 10 && !h.api.permissionDialog; i++) await Promise.resolve();
  assert.equal(h.api.permissionDialog, mode);
  assert.equal(h.api.phase, "permission");
}

test("blocked permission shows a custom Settings choice without requesting or starting capture", async () => {
  const h = mount();
  h.service.currentPermission = { granted: false, canAskAgain: false, status: "denied" };
  const pending = h.api.start();
  await waitForDialog(h, "settings");
  await h.api.start();
  assert.equal(h.service.calls.permissions, 0);
  assert.equal(h.service.calls.start.length, 0);
  h.api.respondToPermission(false);
  await pending;
  assert.equal(h.api.phase, "idle");
  assert.equal(h.api.permissionDialog, null);
  assert.equal(h.settings.length, 0);
  const message = h.api.error;
  const again = h.api.start();
  assert.equal(h.api.error, message);
  await waitForDialog(h, "settings");
  h.api.respondToPermission(true);
  h.api.respondToPermission(true);
  await again;
  assert.equal(h.settings.length, 1);
  assert.equal(h.service.calls.permissions, 0);
});

test("a denied permission offers a custom rationale and Not now never reopens the system prompt", async () => {
  const h = mount();
  h.service.currentPermission = { granted: false, canAskAgain: true, status: "denied" };
  const pending = h.api.start();
  await waitForDialog(h, "rationale");
  h.api.respondToPermission(false);
  await pending;
  assert.equal(h.api.phase, "idle");
  assert.equal(h.service.calls.permissions, 0);
  assert.equal(h.service.calls.start.length, 0);
});

test("Continue requests permission once and a second denial leads to Settings on the next tap", async () => {
  const h = mount();
  h.service.currentPermission = { granted: false, canAskAgain: true, status: "denied" };
  h.service.permission = { granted: false, canAskAgain: false, status: "denied" };
  const pending = h.api.start();
  await waitForDialog(h, "rationale");
  h.api.respondToPermission(true);
  await pending;
  assert.equal(h.service.calls.permissions, 1);
  assert.equal(h.service.calls.start.length, 0);
  assert.equal(h.api.canOpenSettings, true);
  h.service.currentPermission = h.service.permission;
  const next = h.api.start();
  await waitForDialog(h, "settings");
  assert.equal(h.service.calls.permissions, 1);
  h.api.respondToPermission(false);
  await next;
});

for (const mode of ["rationale", "settings"]) {
  for (const leave of ["scope", "background", "unmount"]) {
    test(`${mode} dialog cancels pending work on ${leave}`, async () => {
      const h = mount();
      h.service.currentPermission = { granted: false, canAskAgain: mode === "rationale", status: "denied" };
      const pending = h.api.start();
      await waitForDialog(h, mode);
      const staleResponse = h.api.respondToPermission;
      if (leave === "scope") h.update({ scopeKey: "another-thread" });
      else if (leave === "background") h.appState("background");
      else h.unmount();
      staleResponse(true);
      await pending;
      assert.equal(h.service.calls.permissions, 0);
      assert.equal(h.service.calls.start.length, 0);
      assert.equal(h.settings.length, 0);
      if (leave !== "unmount") {
        assert.equal(h.api.permissionDialog, null);
        assert.equal(h.api.phase, "idle");
      }
    });
  }
}

test("granting microphone permission in Settings allows dictation without another permission prompt", async () => {
  const h = mount();
  h.service.currentPermission = { granted: true, canAskAgain: true, status: "granted" };
  await listen(h);
  assert.equal(h.service.calls.permissions, 0);
  assert.equal(h.api.permissionDialog, null);
  h.api.cancel();
  h.emit("end");
});
