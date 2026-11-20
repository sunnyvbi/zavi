import { describe, it, expect } from "vitest";
import { scrubDom, MAX_OUTPUT_BYTES } from "../dom-scrub";

const SECRETS = {
  email: "janedoe.customer@example.com",
  fullName: "Jane Elizabeth Doe",
  phone: "+1-415-555-0137",
  ccLast4: "4242",
  internalUuid: "9f8b7c6d-1e2f-4a3b-8c9d-0e1f2a3b4c5d",
  authToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.SECRETPAYLOAD.sig",
  inputValue: "Jane's saved billing address, 500 Market St",
  csrfToken: "csrf-Zm9vYmFyYmF6cXV4-8891",
  scriptPii: "scriptleak.user@example.com",
  commentPii: "TODO remove before prod: admin backdoor pass hunter2secret",
} as const;

const LOGGED_IN_DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <title>Account — ${SECRETS.fullName}</title>
  <style>.pii-in-css::after { content: "${SECRETS.email}"; }</style>
  <script type="application/json" id="__NEXT_DATA__">
    {"user":{"email":"${SECRETS.scriptPii}","name":"${SECRETS.fullName}","id":"${SECRETS.internalUuid}"}}
  </script>
</head>
<body>
  <!-- ${SECRETS.commentPii} -->
  <header id="app-header" class="topbar" data-testid="global-header" role="banner">
    <span class="greeting" data-testid="user-greeting">Welcome back, ${SECRETS.fullName}</span>
    <a class="profile-link" data-testid="profile-link"
       href="https://app.example.com/account/settings?token=${SECRETS.authToken}&email=${SECRETS.email}#billing">
       ${SECRETS.email}
    </a>
    <a class="support-mail" href="mailto:${SECRETS.email}">Email support</a>
    <a class="call-us" href="tel:${SECRETS.phone}">Call</a>
  </header>
  <main id="dashboard" class="dashboard-grid" data-testid="dashboard-root">
    <section class="billing-card" data-testid="billing-card" data-plan="pro">
      <h2 class="card-title">Payment method</h2>
      <p class="cc-line" data-testid="cc-last4">Visa ending ${SECRETS.ccLast4}</p>
      <span class="phone" data-testid="phone">${SECRETS.phone}</span>
      <form id="billing-form" method="post" action="/account/billing?session=${SECRETS.csrfToken}">
        <input type="hidden" name="csrf_token" value="${SECRETS.csrfToken}" />
        <input type="text" name="address" id="addr-input"
               value="${SECRETS.inputValue}"
               placeholder="${SECRETS.fullName}, home address"
               title="Editing ${SECRETS.email}" />
        <img class="avatar" data-testid="avatar"
             src="https://cdn.example.com/avatars/current.png?sig=${SECRETS.authToken}"
             alt="${SECRETS.fullName}'s avatar" />
        <button type="submit" class="save-btn" data-testid="save-billing"
                onmouseover="track('${SECRETS.email}')"
                customattr="${SECRETS.email}">Save</button>
      </form>
    </section>
    <ul id="support-notes" class="notes" data-testid="support-notes">
      <li class="note-item" data-note-id="note-7">Refund case ${SECRETS.internalUuid} for ${SECRETS.fullName}</li>
    </ul>
  </main>
</body>
</html>`;

describe("scrubDom — PII containment boundary", () => {
  const { html: out, stats } = scrubDom(LOGGED_IN_DASHBOARD_HTML);

  it("does not leak ANY secret literal into the output (scanned, not trusted)", () => {
    for (const [label, secret] of Object.entries(SECRETS)) {
      expect(out, `secret "${label}" (${secret}) survived scrubDom`).not.toContain(secret);
    }
  });

  it("strips the auth token even though its host attr (href/src) is kept", () => {
    expect(out).toContain("app.example.com/account/settings");
    expect(out).not.toContain(SECRETS.authToken);
    expect(out).not.toContain("token=");
    expect(out).not.toContain("email=");
  });

  it("drops mailto: and tel: attrs entirely (their PATH is the PII)", () => {
    expect(out).not.toContain("mailto:");
    expect(out).not.toContain("tel:");
  });

  it("empties <script> and <style> bodies but keeps the tags as structure", () => {
    expect(out).toContain("<script");
    expect(out).toContain("<style");
    expect(out).toContain('id="__NEXT_DATA__"');
    expect(out).not.toContain(SECRETS.scriptPii);
    expect(out).not.toContain("content:");
    expect(out).not.toContain('{"user"');
  });

  it("removes HTML comments entirely", () => {
    expect(out).not.toContain(SECRETS.commentPii);
    expect(out).not.toContain("<!--");
  });

  it("stats reflect real work: text stripped, attrs stripped, byte accounting", () => {
    expect(stats.textNodesStripped).toBeGreaterThan(0);
    expect(stats.attrsStripped).toBeGreaterThan(0);
    expect(stats.bytesIn).toBe(Buffer.byteLength(LOGGED_IN_DASHBOARD_HTML, "utf8"));
    expect(stats.bytesOut).toBe(Buffer.byteLength(out, "utf8"));
  });
});

describe("scrubDom — STRUCTURE survives (the feature must still work)", () => {
  const { html: out } = scrubDom(LOGGED_IN_DASHBOARD_HTML);

  it("keeps ids, classes, roles, and data-testid hooks the agent greps on", () => {
    for (const id of ["app-header", "dashboard", "billing-form", "addr-input", "support-notes"]) {
      expect(out).toContain(`id="${id}"`);
    }
    for (const cls of ["topbar", "dashboard-grid", "billing-card", "save-btn", "note-item"]) {
      expect(out).toContain(cls);
    }
    for (const tid of ["global-header", "dashboard-root", "billing-card", "save-billing", "support-notes", "avatar"]) {
      expect(out).toContain(`data-testid="${tid}"`);
    }
    expect(out).toContain('role="banner"');
  });

  it("keeps tag nesting / tree shape (header > a, main > section > form > input)", () => {
    expect(out).toMatch(/<header[^>]*>[\s\S]*<a[^>]*>[\s\S]*<\/header>/);
    expect(out).toMatch(/<main[^>]*>[\s\S]*<section[^>]*>[\s\S]*<form[^>]*>[\s\S]*<input[^>]*>/);
  });

  it("keeps structural form attrs (type, name, method) — field SHAPE, not content", () => {
    expect(out).toContain('type="hidden"');
    expect(out).toContain('name="csrf_token"');
    expect(out).not.toContain(SECRETS.csrfToken);
    expect(out).toContain('method="post"');
  });

  it("replaces text nodes with a length-bearing placeholder, not deletion", () => {
    expect(out).toMatch(/«text:\d+»/);
  });
});

describe("scrubDom — FAIL CLOSED (allowlist, not blocklist)", () => {
  it("strips an event-handler attr (onmouseover) — not on the allowlist", () => {
    const { html } = scrubDom(`<button onmouseover="steal('a@b.com')" class="x">Go</button>`);
    expect(html).not.toContain("onmouseover");
    expect(html).not.toContain("a@b.com");
    expect(html).toContain('class="x"');
  });

  it("strips an unknown/vendor attr (customattr) carrying PII", () => {
    const { html } = scrubDom(`<div customattr="secret@x.com" id="keep">z</div>`);
    expect(html).not.toContain("customattr");
    expect(html).not.toContain("secret@x.com");
    expect(html).toContain('id="keep"');
  });

  it("strips a future/unknown attr by DEFAULT (the fail-closed invariant)", () => {
    const { html } = scrubDom(`<x-widget data-testid="ok" quantum-flux="pii:z@z.com">t</x-widget>`);
    expect(html).not.toContain("quantum-flux");
    expect(html).not.toContain("z@z.com");
    expect(html).toContain('data-testid="ok"');
  });

  it("drops data:/javascript: URL schemes entirely", () => {
    const { html } = scrubDom(
      `<a href="javascript:steal()">x</a><img src="data:image/png;base64,QUJD"/>`,
    );
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:image");
    expect(html).not.toContain("QUJD");
  });

  it("neutralizes url() inside an inline style (token could hide there)", () => {
    const { html } = scrubDom(
      `<div style="color:red;background:url('https://x.com/i?token=SEKRET')">t</div>`,
    );
    expect(html).not.toContain("SEKRET");
    expect(html).toContain("color:red");
  });
});

describe("scrubDom — robustness", () => {
  it("never throws on malformed / partial HTML", () => {
    for (const bad of ["", "<div><span>unclosed", "<<<>>", "plain text no tags", "<a href=", "</p></p></div>"]) {
      expect(() => scrubDom(bad)).not.toThrow();
    }
  });

  it("caps output at MAX_OUTPUT_BYTES and marks truncation", () => {
    const huge = "<div>" + "<span class='row' data-testid='r'>x</span>".repeat(40000) + "</div>";
    const { html, stats } = scrubDom(huge);
    expect(stats.bytesOut).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(html).toContain("[scrub:truncated]");
  });
});

describe("scrubDom — property: generated PII in strip-vectors is always gone", () => {
  function makePii(seed: number): string {
    return `pii${seed}_${(seed * 2654435761 >>> 0).toString(36)}@leak-${seed}.example.com`;
  }
  type Vector = (pii: string) => string;
  const vectors: Vector[] = [
    (p) => `<p>${p}</p>`,
    (p) => `<div>a <b>${p}</b> b</div>`,
    (p) => `<input value="${p}" name="f"/>`,
    (p) => `<img alt="${p}" src="/x.png"/>`,
    (p) => `<span title="${p}">t</span>`,
    (p) => `<!-- ${p} -->`,
    (p) => `<script>var x=${JSON.stringify(p)};</script>`,
    (p) => `<style>.a::after{content:"${p}"}</style>`,
    (p) => `<a href="/go?u=${encodeURIComponent(p)}">l</a>`,
    (p) => `<a href="/go#${p}">l</a>`,
    (p) => `<button onclick="f('${p}')">x</button>`,
    (p) => `<div mystery-attr="${p}">x</div>`,
    (p) => `<a href="mailto:${p}">m</a>`,
  ];

  it("no generated secret appears in output across 13 vectors × many positions", () => {
    const chunks: string[] = ["<!DOCTYPE html><html><body>"];
    const secrets: string[] = [];
    let seed = 1;
    for (let round = 0; round < 30; round++) {
      for (const v of vectors) {
        const pii = makePii(seed++);
        secrets.push(pii);
        chunks.push(`<section class="s${seed}" data-testid="t${seed}">`, v(pii), "</section>");
      }
    }
    chunks.push("</body></html>");
    const { html } = scrubDom(chunks.join("\n"));
    for (const s of secrets) {
      expect(html, `generated secret survived: ${s}`).not.toContain(s);
    }
    expect(html).toContain('data-testid="t2"');
  });
});
