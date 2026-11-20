import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createSandbox, destroySandbox } from "@/services/sandbox/e2b-client";
import { callDaemon, _resetDaemonReadyCache } from "../daemon-client";

const E2E = process.env.BROWSER_MCP_E2E === "1";
const describeE2E = E2E ? describe : describe.skip;

describeE2E("browser-mcp — integration (live e2b sandbox)", () => {
  let sandbox_id: string;

  beforeAll(async () => {
    _resetDaemonReadyCache();
    sandbox_id = await createSandbox({
      tenant_id: "test-tenant-browser-mcp",
      repo_full_name: "rravi149/praxis",
    });
  }, 120_000);

  afterAll(async () => {
    if (sandbox_id) {
      try {
        await destroySandbox(sandbox_id);
      } catch (_) {
      }
    }
  }, 30_000);

  it("browser_nav boots the daemon + Chromium and navigates to a data URL", async () => {
    const r = await callDaemon(sandbox_id, {
      op: "nav",
      url: "data:text/html,<html><body><h1>Hello QA</h1></body></html>",
    });
    expect(r.ok).toBe(true);
    const t = await callDaemon(sandbox_id, { op: "text", selector: "h1" });
    expect(t.ok).toBe(true);
    expect((t as { result: string }).result).toBe("Hello QA");
  }, 60_000);

  it("browser_fill works on a controlled-input fixture (native value setter)", async () => {
    const fixture =
      "data:text/html," +
      encodeURIComponent(`
      <!doctype html>
      <html><body>
        <input id="email" type="text" />
        <span id="echo">GOT:</span>
        <script>
          (function () {
            var input = document.getElementById("email");
            var echo = document.getElementById("echo");
            // Mimic React's _valueTracker — override the descriptor so
            // assignments via the plain .value setter are silently dropped
            // (matches the React-controlled-input failure mode the trick
            // was built to defeat). Only the prototype-descriptor setter
            // (Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,
            // 'value').set.call(...)) bypasses this.
            // The getter MUST delegate to the native prototype getter so
            // reads after a native-setter write see the actual DOM value
            // (otherwise e.target.value in the input listener returns the
            // override-tracked value and the test can't verify the trick
            // worked).
            var proto = HTMLInputElement.prototype;
            var nativeGet = Object.getOwnPropertyDescriptor(proto, "value").get;
            Object.defineProperty(input, "value", {
              get: function () { return nativeGet.call(this); },
              set: function (_) { /* swallow plain-setter assignments */ },
              configurable: true,
            });
            input.addEventListener("input", function (e) {
              // e.target.value goes through the override getter → native
              // getter → underlying DOM value (written by the native
              // setter). If the native-setter trick is wrong, the input
              // event never fires; if it's right, e.target.value here is
              // the new value.
              echo.textContent = "GOT:" + e.target.value;
            });
          })();
        </script>
      </body></html>
    `);
    const nav = await callDaemon(sandbox_id, { op: "nav", url: fixture });
    expect(nav.ok).toBe(true);
    await callDaemon(sandbox_id, { op: "wait_for", selector: "#echo" });
    const fill = await callDaemon(sandbox_id, {
      op: "fill",
      selector: "#email",
      value: "hello@praxis",
    });
    expect(fill.ok).toBe(true);
    const echo = await callDaemon(sandbox_id, { op: "text", selector: "#echo" });
    expect((echo as { result: string }).result).toBe("GOT:hello@praxis");
  }, 60_000);

  it("daemon persists state across 10 sequential ops in one sandbox", async () => {
    await callDaemon(sandbox_id, {
      op: "nav",
      url: "data:text/html,<html><body><span id=count>0</span><script>window.c=0;</script></body></html>",
    });
    for (let i = 1; i <= 10; i++) {
      const t = await callDaemon(sandbox_id, { op: "text", selector: "#count" });
      expect(t.ok).toBe(true);
    }
  }, 60_000);
});
