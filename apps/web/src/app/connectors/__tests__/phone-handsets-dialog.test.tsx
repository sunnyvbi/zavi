
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PhoneHandsetsDialog, removeHandsetPrompt } from "../PhoneHandsetsDialog";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));

const HANDSETS = [
  { id: "th-1", name: "Aryaan", number: "+1 ••• ••• 6032" },
  { id: "th-2", name: "Ravi", number: "+1 ••• ••• 7710" },
  { id: "th-3", name: null, number: "••• 3210" },
];

const noop = () => {};

describe("PhoneHandsetsDialog", () => {
  it("names every bound phone and falls back to the masked number", () => {
    const html = renderToStaticMarkup(
      <PhoneHandsetsDialog surface="whatsapp" handsets={HANDSETS} onClose={noop} onChanged={noop} onAddNumber={noop} />,
    );
    expect(html).toContain("Aryaan");
    expect(html).toContain("Ravi");
    expect(html).toContain("+1 ••• ••• 6032");
    expect(html).toContain("••• 3210");
  });

  it("gives each phone its own Remove control, labelled by who it is", () => {
    const html = renderToStaticMarkup(
      <PhoneHandsetsDialog surface="whatsapp" handsets={HANDSETS} onClose={noop} onChanged={noop} onAddNumber={noop} />,
    );
    expect(html.match(/>Remove</g)?.length).toBe(3);
    expect(html).toContain('aria-label="Remove Aryaan"');
    expect(html).toContain('aria-label="Remove ••• 3210"');
  });

  it("does not print a second number line for a phone that has no name", () => {
    const html = renderToStaticMarkup(
      <PhoneHandsetsDialog surface="whatsapp" handsets={[HANDSETS[2]!]} onClose={noop} onChanged={noop} onAddNumber={noop} />,
    );
    expect(html.match(/••• 3210/g)?.length).toBe(1 + 1);
  });

  it("offers the two-step connect for another phone", () => {
    const html = renderToStaticMarkup(
      <PhoneHandsetsDialog surface="whatsapp" handsets={HANDSETS} onClose={noop} onChanged={noop} onAddNumber={noop} />,
    );
    expect(html).toContain("Add another number");
  });

  it("says which phone the Remove confirm is about", () => {
    expect(removeHandsetPrompt(HANDSETS[0]!, "WhatsApp")).toMatch(/^Remove Aryaan \(\+1 ••• ••• 6032\) from WhatsApp\?/);
    expect(removeHandsetPrompt(HANDSETS[2]!, "WhatsApp")).toMatch(/^Remove ••• 3210 from WhatsApp\?/);
  });
});
