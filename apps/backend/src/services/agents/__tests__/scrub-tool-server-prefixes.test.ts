import { describe, it, expect } from "vitest";
import { INTERNAL_TOOL_SERVER_PREFIXES, scrubToolNamesAndStoragePaths } from "../scrub-agent-egress";
import { INTERNAL_SERVERS } from "@/services/mcp/tool-effect-classifier";

describe("scrubToolNamesAndStoragePaths — server coverage", () => {
  it("covers every internal tool server, so a new server's tool names cannot leak", () => {
    for (const server of INTERNAL_SERVERS) {
      expect(INTERNAL_TOOL_SERVER_PREFIXES).toContain(server);
      expect(scrubToolNamesAndStoragePaths(`ran ${server}__do_thing now`).text).toBe("ran a tool now");
    }
  });
});

describe("scrubToolNamesAndStoragePaths — inline code", () => {
  const path = "0f8e1c2a-1b2c-4d3e-8f90-123456789abc/9a8b7c6d-5e4f-4a3b-9c2d-abcdef012345.png";

  it("keeps a filter the customer quoted as inline code, while a bare tool name in the same reply is still redacted", () => {
    const r = scrubToolNamesAndStoragePaths("Use `product__price__gte` and `email__iexact` to filter; I ran social__list_posts first.");
    expect(r.text).toBe("Use `product__price__gte` and `email__iexact` to filter; I ran a tool first.");
    expect(r.hits).toBe(1);
  });

  it("still replaces a storage path even when it sits inside backticks", () => {
    const r = scrubToolNamesAndStoragePaths(`Saved \`${path}\` and ${path} for the pin.`);
    expect(r.text).toBe("Saved the image file and the image file for the pin.");
    expect(r.hits).toBe(2);
  });
});
