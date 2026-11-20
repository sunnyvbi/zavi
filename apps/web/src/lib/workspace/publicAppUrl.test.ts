import { describe, it, expect } from "vitest";
import { isInternalHostUrl, publicAppUrl, routeLabel } from "./publicAppUrl";

describe("publicAppUrl — the hosting provider never reaches the founder's screen", () => {
  it("hides any onrender.com host, whatever the path, port or case", () => {
    expect(publicAppUrl("https://upcarai-6ec4d609.onrender.com")).toBeNull();
    expect(publicAppUrl("https://UpcarAI.OnRender.com/browse?x=1")).toBeNull();
    expect(publicAppUrl("http://x.onrender.com:443/")).toBeNull();
    expect(isInternalHostUrl("https://onrender.com")).toBe(true);
  });

  it("keeps the Zavi address and a customer's own domain", () => {
    expect(publicAppUrl("https://upcar-ai.zaviagent.com")).toBe("https://upcar-ai.zaviagent.com");
    expect(publicAppUrl("https://app.acme.com/")).toBe("https://app.acme.com/");
  });

  it("does not match a look-alike host", () => {
    expect(publicAppUrl("https://notonrender.company.com")).toBe("https://notonrender.company.com");
    expect(publicAppUrl("https://onrender.com.acme.io")).toBe("https://onrender.com.acme.io");
  });

  it("passes null and garbage through as null / unchanged", () => {
    expect(publicAppUrl(null)).toBeNull();
    expect(publicAppUrl(undefined)).toBeNull();
    expect(publicAppUrl("not a url")).toBe("not a url");
  });

  it("routeLabel shows the route, never the host", () => {
    expect(routeLabel("https://x.onrender.com")).toBe("Home");
    expect(routeLabel("https://x.onrender.com/browse?x=1")).toBe("/browse?x=1");
    expect(routeLabel(null)).toBe("Home");
  });
});
