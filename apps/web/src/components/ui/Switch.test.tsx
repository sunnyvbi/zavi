import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Switch } from "./Switch";

describe("Switch", () => {
  it("renders the checked pill with an accessible label", () => {
    const html = renderToStaticMarkup(
      <Switch checked label="Disable email for teammate" onCheckedChange={() => undefined} />,
    );

    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('aria-label="Disable email for teammate"');
    expect(html).toContain("bg-ink");
    expect(html).toContain("translate-x-5");
  });

  it("renders the unchecked pill using the muted token", () => {
    const html = renderToStaticMarkup(
      <Switch checked={false} label="Enable email for teammate" onCheckedChange={() => undefined} />,
    );

    expect(html).toContain('aria-checked="false"');
    expect(html).toContain("bg-ink/20");
    expect(html).toContain("translate-x-0");
  });
});
