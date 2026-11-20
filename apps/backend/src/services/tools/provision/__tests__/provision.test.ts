
import { describe, it, expect } from "vitest";
import { provisionRepoTool } from "../repo";
import { provisionHostingTool } from "../hosting";

const FAKE_CTX = {
  tenant_id: "test-tenant",
  log: () => {},
};

describe("provision/repo — DRY-RUN tool", () => {
  it("returns dry_run:true + created:false", async () => {
    const result = await provisionRepoTool.execute(FAKE_CTX, {
      company_name: "Acme Corp",
      stack: "nextjs-supabase-tailwind",
      dry_run: true,
    });
    expect(result.dry_run).toBe(true);
    expect(result.created).toBe(false);
  });

  it("derives the repo_full_name from company_name", async () => {
    const result = await provisionRepoTool.execute(FAKE_CTX, {
      company_name: "Acme Corp",
      stack: "nextjs-supabase-tailwind",
      dry_run: true,
    });
    expect(result.repo_full_name).toBe("praxis-built/acme-corp");
  });

  it("includes repo_url and default_branch", async () => {
    const result = await provisionRepoTool.execute(FAKE_CTX, {
      company_name: "My Startup",
      stack: "nextjs-supabase-tailwind",
      dry_run: true,
    });
    expect(result.repo_url).toBe("https://github.com/praxis-built/my-startup");
    expect(result.default_branch).toBe("main");
  });

  it("passes the stack through to the result", async () => {
    const result = await provisionRepoTool.execute(FAKE_CTX, {
      company_name: "Test Co",
      stack: "nextjs-supabase-tailwind",
      dry_run: true,
    });
    expect(result.stack).toBe("nextjs-supabase-tailwind");
  });

  it("slugifies special characters in company_name", async () => {
    const result = await provisionRepoTool.execute(FAKE_CTX, {
      company_name: "Foo & Bar, Inc.",
      stack: "nextjs-supabase-tailwind",
      dry_run: true,
    });
    expect(result.repo_full_name).toBe("praxis-built/foo-bar-inc");
  });

  it("includes a note explaining that no real repo was created", async () => {
    const result = await provisionRepoTool.execute(FAKE_CTX, {
      company_name: "Test Co",
      stack: "nextjs-supabase-tailwind",
      dry_run: true,
    });
    expect(result.note).toMatch(/DRY-RUN/i);
  });
});

describe("provision/hosting — DRY-RUN tool", () => {
  it("returns dry_run:true + created:false", async () => {
    const result = await provisionHostingTool.execute(FAKE_CTX, {
      company_name: "Acme Corp",
      stack: "nextjs-supabase-tailwind",
      dry_run: true,
    });
    expect(result.dry_run).toBe(true);
    expect(result.created).toBe(false);
  });

  it("derives the url from company_name", async () => {
    const result = await provisionHostingTool.execute(FAKE_CTX, {
      company_name: "Acme Corp",
      stack: "nextjs-supabase-tailwind",
      dry_run: true,
    });
    expect(result.url).toBe("https://acme-corp.vercel.app");
  });

  it("sets provider to vercel", async () => {
    const result = await provisionHostingTool.execute(FAKE_CTX, {
      company_name: "My Startup",
      stack: "nextjs-supabase-tailwind",
      dry_run: true,
    });
    expect(result.provider).toBe("vercel");
  });

  it("passes the stack through to the result", async () => {
    const result = await provisionHostingTool.execute(FAKE_CTX, {
      company_name: "Test Co",
      stack: "nextjs-supabase-tailwind",
      dry_run: true,
    });
    expect(result.stack).toBe("nextjs-supabase-tailwind");
  });

  it("slugifies special characters in company_name", async () => {
    const result = await provisionHostingTool.execute(FAKE_CTX, {
      company_name: "Foo & Bar, Inc.",
      stack: "nextjs-supabase-tailwind",
      dry_run: true,
    });
    expect(result.url).toBe("https://foo-bar-inc.vercel.app");
  });

  it("includes a note explaining that no real hosting was created", async () => {
    const result = await provisionHostingTool.execute(FAKE_CTX, {
      company_name: "Test Co",
      stack: "nextjs-supabase-tailwind",
      dry_run: true,
    });
    expect(result.note).toMatch(/DRY-RUN/i);
  });
});
