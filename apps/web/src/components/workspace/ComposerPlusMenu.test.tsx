import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ComposerPlusMenu } from "./ComposerPlusMenu";

vi.mock("@/lib/workspace/useGithubRepos", () => ({
  useGithubRepos: () => ({
    state: { status: "loading" },
    pending: false,
    setDefault: async () => ({ ok: true }),
  }),
}));

function render(props: Partial<React.ComponentProps<typeof ComposerPlusMenu>>) {
  return renderToStaticMarkup(
    <ComposerPlusMenu
      onAttach={() => {}}
      repoEnabled={false}
      role="owner"
      onManageRepos={() => {}}
      {...props}
    />,
  );
}

describe("ComposerPlusMenu", () => {
  it("stays a plain attach button when the agent does not work a repo", () => {
    const html = render({ repoEnabled: false });
    expect(html).toContain('aria-label="Attach image"');
    expect(html).not.toContain('aria-label="Add to this message"');
  });

  it("becomes a menu trigger when the repo item is enabled", () => {
    const html = render({ repoEnabled: true });
    expect(html).toContain('aria-label="Add to this message"');
  });

  it("renders closed — no menu surface until it is opened", () => {
    const html = render({ repoEnabled: true });
    expect(html).not.toContain('role="menu"');
    expect(html).not.toContain('role="menuitem"');
  });
});
