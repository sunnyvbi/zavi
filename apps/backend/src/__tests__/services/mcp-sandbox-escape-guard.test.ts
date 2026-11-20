import { describe, it, expect } from "vitest";
import { escapeGuardRefusal } from "@/services/agents/sdk/mcp-sandbox";

const ROOT = "/home/user/wt-abcd1234";

describe("escapeGuardRefusal", () => {
  it("allows a command that touches only the worktree root or descendants", () => {
    expect(escapeGuardRefusal("ls", ROOT)).toBeNull();
    expect(escapeGuardRefusal("npm test", ROOT)).toBeNull();
    expect(escapeGuardRefusal("git status", ROOT)).toBeNull();
    expect(escapeGuardRefusal(`cat ${ROOT}/package.json`, ROOT)).toBeNull();
    expect(escapeGuardRefusal(`ls ${ROOT}`, ROOT)).toBeNull();
    expect(escapeGuardRefusal("cd apps/backend && npm test", ROOT)).toBeNull();
  });

  it("refuses any `cd /<abs>` regardless of destination", () => {
    expect(escapeGuardRefusal("cd /etc", ROOT)).toMatch(/cd \/<abs>/);
    expect(escapeGuardRefusal("cd /tmp && ls", ROOT)).toMatch(/cd \/<abs>/);
    expect(escapeGuardRefusal("foo && cd /home/user/repo", ROOT)).toMatch(
      /cd \/<abs>/,
    );
    expect(escapeGuardRefusal("cd /", ROOT)).toMatch(/cd \/<abs>/);
  });

  it("refuses absolute paths outside the worktree root", () => {
    expect(escapeGuardRefusal("cat /etc/passwd", ROOT)).toMatch(
      /absolute path outside/,
    );
    expect(
      escapeGuardRefusal("cat /home/user/repo/package.json", ROOT),
    ).toMatch(/absolute path outside/);
    expect(
      escapeGuardRefusal("rm -rf /home/user/wt-othertask", ROOT),
    ).toMatch(/absolute path outside/);
    expect(escapeGuardRefusal("cp /var/log/sandbox.log .", ROOT)).toMatch(
      /absolute path outside/,
    );
  });

  it("error string names the offending path so the LLM can self-correct", () => {
    const r = escapeGuardRefusal("cat /etc/passwd", ROOT);
    expect(r).toContain("/etc/passwd");
    expect(r).toContain(ROOT);
  });

  it("does NOT flag relative paths or substrings inside arguments", () => {
    expect(escapeGuardRefusal("grep -r foo .", ROOT)).toBeNull();
    expect(escapeGuardRefusal("echo 'http://example.com/a/b'", ROOT)).toBeNull();
    expect(escapeGuardRefusal("node --version", ROOT)).toBeNull();
    expect(escapeGuardRefusal("git log --oneline -10", ROOT)).toBeNull();
  });

  it("handles the worktree root as the FIRST argument cleanly", () => {
    expect(escapeGuardRefusal(`ls ${ROOT}`, ROOT)).toBeNull();
    expect(escapeGuardRefusal(`stat ${ROOT}`, ROOT)).toBeNull();
  });

  it("refuses a path that almost-matches the root (no path-prefix attack)", () => {
    const sneaky = `${ROOT}other/foo`;
    const refused = escapeGuardRefusal(`cat ${sneaky}`, ROOT);
    expect(refused).toMatch(/absolute path outside/);
    expect(refused).toContain(sneaky);
  });

  it("refuses commands that mix allowed + disallowed paths (the FIRST violation surfaces)", () => {
    const r = escapeGuardRefusal(
      `cp ${ROOT}/a.txt /etc/passwd-copy && echo ok`,
      ROOT,
    );
    expect(r).toMatch(/absolute path outside/);
    expect(r).toContain("/etc/passwd-copy");
  });

  it("handles common test invocations cleanly", () => {
    expect(escapeGuardRefusal("npm test", ROOT)).toBeNull();
    expect(escapeGuardRefusal("npm run typecheck", ROOT)).toBeNull();
    expect(escapeGuardRefusal("pytest -xvs", ROOT)).toBeNull();
    expect(escapeGuardRefusal("go test ./...", ROOT)).toBeNull();
  });

  describe("relative parent-directory traversal (cross-worktree escape hole)", () => {
    it("refuses a bare `cd ..` (lands in /home/user, the parent of all worktrees)", () => {
      expect(escapeGuardRefusal("cd ..", ROOT)).toMatch(/parent-directory traversal/);
    });

    it("refuses climbing to a sibling worktree or the shared clone via relative `..`", () => {
      expect(escapeGuardRefusal("cd ../wt-othertask && cat secret.txt", ROOT)).toMatch(
        /parent-directory traversal/,
      );
      expect(escapeGuardRefusal("cd ../repo && git log", ROOT)).toMatch(
        /parent-directory traversal/,
      );
      expect(escapeGuardRefusal("cat ../wt-sibling/.env", ROOT)).toMatch(
        /parent-directory traversal/,
      );
      expect(escapeGuardRefusal("cp x.txt ../wt-sibling/x.txt", ROOT)).toMatch(
        /parent-directory traversal/,
      );
    });

    it("refuses traversal hidden behind flags / non-cd builtins", () => {
      expect(escapeGuardRefusal("git -C .. log", ROOT)).toMatch(/parent-directory traversal/);
      expect(escapeGuardRefusal("tar -C .. -xf bundle.tar", ROOT)).toMatch(
        /parent-directory traversal/,
      );
      expect(escapeGuardRefusal("pushd ..", ROOT)).toMatch(/parent-directory traversal/);
      expect(escapeGuardRefusal('cd "../repo"', ROOT)).toMatch(/parent-directory traversal/);
      expect(escapeGuardRefusal("cd '..'", ROOT)).toMatch(/parent-directory traversal/);
    });

    it("does NOT false-positive on literal dots that are not traversal", () => {
      expect(escapeGuardRefusal("echo 'version 1.2..3'", ROOT)).toBeNull();
      expect(escapeGuardRefusal("cat foo..bar.txt", ROOT)).toBeNull();
      expect(escapeGuardRefusal("git log --oneline -10", ROOT)).toBeNull();
      expect(escapeGuardRefusal("go test ./...", ROOT)).toBeNull();
      expect(escapeGuardRefusal("npm run build && npm test", ROOT)).toBeNull();
    });
  });

  describe("false positives on ordinary commands (must NOT block)", () => {
    it("allows redirects to the standard streams", () => {
      expect(escapeGuardRefusal("ls apps/ 2>/dev/null", ROOT)).toBeNull();
      expect(escapeGuardRefusal("grep -rn foo src > /dev/null", ROOT)).toBeNull();
      expect(escapeGuardRefusal("echo hi >/dev/stderr", ROOT)).toBeNull();
      expect(escapeGuardRefusal("tsc --noEmit | tee /dev/stdout", ROOT)).toBeNull();
    });

    it("allows a path through a bracketed dynamic route segment", () => {
      expect(
        escapeGuardRefusal('grep -n accountStatus "apps/admin/src/app/trip-details/[tripId]/page.tsx"', ROOT),
      ).toBeNull();
      expect(escapeGuardRefusal("wc -l apps/admin/src/app/[userId]/page.tsx", ROOT)).toBeNull();
    });

    it("still blocks real escapes next to the allowed forms", () => {
      expect(escapeGuardRefusal("cat /etc/passwd", ROOT)).toMatch(/\/etc\/passwd/);
      expect(escapeGuardRefusal("cat '/etc/passwd'", ROOT)).toMatch(/\/etc\/passwd/);
      expect(escapeGuardRefusal("cat /dev/nullx", ROOT)).toMatch(/\/dev\/nullx/);
      expect(escapeGuardRefusal("ls /dev/null/../../etc", ROOT)).not.toBeNull();
      expect(escapeGuardRefusal("cat /dev/sda", ROOT)).toMatch(/\/dev\/sda/);
      expect(escapeGuardRefusal("cat /dev/null]/etc/passwd", ROOT)).not.toBeNull();
      expect(escapeGuardRefusal(`cat ${ROOT}]/etc/passwd`, ROOT)).not.toBeNull();
      expect(escapeGuardRefusal("cd ..", ROOT)).toMatch(/parent-directory traversal/);
      expect(escapeGuardRefusal("ls x 2>/dev/null; cat /home/user/repo/.env", ROOT)).toMatch(
        /\/home\/user\/repo\/\.env/,
      );
    });
  });
});
