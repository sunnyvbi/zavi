// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import { GrowthStartIntake } from "./GrowthStartIntake";

vi.mock("next/image", () => ({
  default: ({ unoptimized, ...props }: ComponentProps<"img"> & { unoptimized?: boolean }) => <img {...props} />,
}));

function Harness({ initial = "" }: { initial?: string }) {
  const [website, setWebsite] = useState(initial);
  return (
    <GrowthStartIntake
      website={website}
      onWebsiteChange={setWebsite}
      error={null}
      onContinue={() => {}}
    />
  );
}

afterEach(cleanup);

function mount(initial?: string) {
  const view = render(<Harness initial={initial} />);
  const input = view.container.querySelector("input") as HTMLInputElement;
  const type = (value: string) => fireEvent.change(input, { target: { value } });
  const img = () => view.container.querySelector("img");
  const globe = () => view.container.querySelector("svg.lucide-globe");
  return { type, img, globe };
}

describe("the Website URL box on /start", () => {
  it("retains the loaded icon when only the path changes", () => {
    const box = mount("https://acme.com/about");
    const image = box.img()!;
    fireEvent.load(image);
    box.type("https://acme.com/pricing");
    expect(box.img()).toBe(image);
    expect(box.globe()).toBeNull();
  });

  it("does not reveal a previous host's late icon", () => {
    const box = mount("acme.com");
    const previous = box.img()!;
    box.type("example.com");
    fireEvent.load(previous);
    expect(box.img()!.getAttribute("src")).toBe("https://example.com/favicon.ico");
    expect(box.globe()).not.toBeNull();
  });

  it("shows the typed site's own favicon once it has loaded", () => {
    const box = mount();
    box.type("youtube.com");

    const img = box.img()!;
    expect(img.getAttribute("src")).toBe("https://youtube.com/favicon.ico");
    expect(box.globe()).not.toBeNull();
    expect(img.className).toContain("opacity-0");

    fireEvent.load(img);
    expect(box.globe()).toBeNull();
    expect(box.img()!.className).not.toContain("opacity-0");
  });

  it("requests the icon immediately when the URL becomes valid", () => {
    const box = mount();
    box.type("youtube.com");
    expect(box.img()!.getAttribute("src")).toBe("https://youtube.com/favicon.ico");
    expect(box.img()!.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("uses the host of a pasted full URL", () => {
    const box = mount();
    box.type("https://www.youtube.com/watch?v=1");
    expect(box.img()!.getAttribute("src")).toBe("https://youtube.com/favicon.ico");
  });

  it("keeps the globe for text that is not a site yet", () => {
    const box = mount();
    for (const value of ["youtube", "youtube.c", "you tube"]) {
      box.type(value);
        expect(box.img()).toBeNull();
      expect(box.globe()).not.toBeNull();
    }
  });

  it("keeps the globe when the site has no favicon", () => {
    const box = mount();
    box.type("nofavicon.example");
    fireEvent.error(box.img()!);
    expect(box.globe()).not.toBeNull();
    expect(box.img()!.className).toContain("opacity-0");
  });

  it("drops the old site's icon the moment the host changes", () => {
    const box = mount();
    box.type("youtube.com");
    fireEvent.load(box.img()!);
    expect(box.globe()).toBeNull();

    box.type("vimeo.com");
    expect(box.img()!.getAttribute("src")).toBe("https://vimeo.com/favicon.ico");
    expect(box.globe()).not.toBeNull();
  });

  it("clears the icon when the box is emptied", () => {
    const box = mount();
    box.type("youtube.com");
    fireEvent.load(box.img()!);
    box.type("");
    expect(box.img()).toBeNull();
    expect(box.globe()).not.toBeNull();
  });

  it("shows the favicon for a site carried in from the home page", () => {
    const box = mount("youtube.com");
    expect(box.img()!.getAttribute("src")).toBe("https://youtube.com/favicon.ico");
  });
});
