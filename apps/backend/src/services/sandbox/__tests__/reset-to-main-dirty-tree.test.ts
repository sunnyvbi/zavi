import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resetToMainScript } from "../e2b-client";

describe("resetToMain on a sandbox left on the old app's live-edit draft", () => {
  it("lands on main even when the preview's dev server dirtied a file the draft changed, and drops the draft's files", () => {
    const root = mkdtempSync(join(tmpdir(), "reset-main-"));
    const sh = (cmd: string, cwd = root) => execSync(cmd, { cwd, stdio: "pipe", encoding: "utf-8" });
    try {
      sh(
        "git init -q -b main origin && cd origin && git config user.email t@t && git config user.name t && " +
          "printf main > tsconfig.json && git add . && git commit -qm main && " +
          "git checkout -qb zavi/draft && printf draft > tsconfig.json && mkdir -p lib app/orders && printf fmt > lib/format.ts && printf orders > app/orders/page.tsx && git add . && git commit -qm draft && git checkout -q main",
      );
      sh("git clone -q origin repo");
      const repo = join(root, "repo");
      sh("git checkout -q -b zavi/draft origin/zavi/draft", repo);
      writeFileSync(join(repo, "tsconfig.json"), "rewritten by next dev");

      const script = resetToMainScript("main", repo).replace("exec 9>/tmp/_praxis_wt.lock && flock -w 60 9 && ", "");
      execSync("bash -s", { cwd: root, input: script, encoding: "utf-8" });

      expect(sh("git rev-parse --abbrev-ref HEAD", repo).trim()).toBe("main");
      expect(readFileSync(join(repo, "tsconfig.json"), "utf-8")).toBe("main");
      expect(existsSync(join(repo, "lib/format.ts"))).toBe(false);
      expect(existsSync(join(repo, "app/orders/page.tsx"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
