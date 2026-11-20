
import { describe, expect, it } from "vitest";
import { probeSandboxDevServer, sameOriginStaticImports, type ProbeFetch } from "../preview-ready-probe";

const BOX = "https://5173-box123.e2b.app";
const HTML =
  '<!doctype html><html><head><script type="module">import R from "/@react-refresh"</script>' +
  '<script type="module" src="/@vite/client"></script></head><body><div id="root"></div>' +
  '<script type="module" src="/src/main.tsx"></script>' +
  '<script type="module" src="https://cdn.example.com/x.js"></script></body></html>';

const MAIN = [
  `import __vite__cjsImport0_react from "/node_modules/.vite/deps/react.js?v=7c1a2b";`,
  `import __vite__cjsImport1_reactDom_client from "/node_modules/.vite/deps/react-dom_client.js?v=7c1a2b";`,
  `import { BrowserRouter } from "/node_modules/.vite/deps/react-router-dom.js?v=7c1a2b";`,
  `import App from "/src/App.tsx";`,
  `import "/src/theme.css";`,
  `import "/src/index.css";`,
  `import * as RefreshRuntime from "/@react-refresh";`,
  `const lazy = () => import("/src/pages/Admin.tsx");`,
  `import ext from "https://cdn.example.com/lib.js";`,
  `//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozfQ==`,
].join("\n");

function serve(map: Record<string, number | (() => Response)>): { fetchFn: ProbeFetch; urls: string[] } {
  const urls: string[] = [];
  const fetchFn: ProbeFetch = async (url) => {
    urls.push(url);
    const hit = map[url];
    if (hit === undefined) return new Response("nope", { status: 404 });
    if (typeof hit === "function") return hit();
    return new Response("export {}", { status: hit });
  };
  return { fetchFn, urls };
}

const HEALTHY: Record<string, number | (() => Response)> = {
  [`${BOX}/`]: () => new Response(HTML, { status: 200, headers: { "content-type": "text/html" } }),
  [`${BOX}/@vite/client`]: 200,
  [`${BOX}/src/main.tsx`]: () => new Response(MAIN, { status: 200, headers: { "content-type": "text/javascript" } }),
  [`${BOX}/node_modules/.vite/deps/react.js?v=7c1a2b`]: 200,
  [`${BOX}/node_modules/.vite/deps/react-dom_client.js?v=7c1a2b`]: 200,
  [`${BOX}/node_modules/.vite/deps/react-router-dom.js?v=7c1a2b`]: 200,
  [`${BOX}/src/App.tsx`]: 200,
  [`${BOX}/src/theme.css`]: 200,
  [`${BOX}/src/index.css`]: 200,
  [`${BOX}/@react-refresh`]: 200,
};

describe("sameOriginStaticImports", () => {
  it("lists the static same-origin imports the dev server rewrote, never dynamic or cross-origin ones", () => {
    expect(sameOriginStaticImports(MAIN, `${BOX}/src/main.tsx`, BOX)).toEqual([
      `${BOX}/node_modules/.vite/deps/react.js?v=7c1a2b`,
      `${BOX}/node_modules/.vite/deps/react-dom_client.js?v=7c1a2b`,
      `${BOX}/node_modules/.vite/deps/react-router-dom.js?v=7c1a2b`,
      `${BOX}/src/App.tsx`,
      `${BOX}/src/theme.css`,
      `${BOX}/src/index.css`,
      `${BOX}/@react-refresh`,
    ]);
  });

  it("resolves relative specifiers against the module and handles export-from", () => {
    const code = `export * from "./sections/Hero.tsx";\nexport { Button } from "../ui/button.tsx";`;
    expect(sameOriginStaticImports(code, `${BOX}/src/components/index.ts`, BOX)).toEqual([
      `${BOX}/src/components/sections/Hero.tsx`,
      `${BOX}/src/ui/button.tsx`,
    ]);
  });

  it("is bounded", () => {
    const code = Array.from({ length: 50 }, (_, i) => `import "/src/m${i}.ts";`).join("\n");
    expect(sameOriginStaticImports(code, `${BOX}/src/main.tsx`, BOX)).toHaveLength(16);
  });
});

describe("probeSandboxDevServer", () => {
  it("is ready when the page, its module scripts and the entry module's imports all answer 2xx", async () => {
    const { fetchFn, urls } = serve(HEALTHY);
    await expect(probeSandboxDevServer(BOX, fetchFn)).resolves.toBe(true);
    expect(urls).toEqual(expect.arrayContaining([`${BOX}/src/App.tsx`, `${BOX}/node_modules/.vite/deps/react.js?v=7c1a2b`]));
    expect(urls.some((u) => u.includes("cdn.example.com"))).toBe(false);
    expect(urls).not.toContain(`${BOX}/src/pages/Admin.tsx`);
  });

  it("is NOT ready while the entry's imports 502 (a dev server restarting under the page)", async () => {
    for (const broken of [`${BOX}/src/App.tsx`, `${BOX}/node_modules/.vite/deps/react.js?v=7c1a2b`, `${BOX}/src/index.css`]) {
      const { fetchFn } = serve({ ...HEALTHY, [broken]: 502 });
      await expect(probeSandboxDevServer(BOX, fetchFn), broken).resolves.toBe(false);
    }
  });

  it("is NOT ready on an outdated optimized dependency (504) or a missing one", async () => {
    const { fetchFn } = serve({ ...HEALTHY, [`${BOX}/node_modules/.vite/deps/react-router-dom.js?v=7c1a2b`]: 504 });
    await expect(probeSandboxDevServer(BOX, fetchFn)).resolves.toBe(false);
    const missing = { ...HEALTHY };
    delete missing[`${BOX}/src/theme.css`];
    await expect(probeSandboxDevServer(BOX, serve(missing).fetchFn)).resolves.toBe(false);
  });

  it("still fails fast when the page or a module script is down, without reading imports", async () => {
    const page = serve({ ...HEALTHY, [`${BOX}/`]: 502 });
    await expect(probeSandboxDevServer(BOX, page.fetchFn)).resolves.toBe(false);
    expect(page.urls).toEqual([`${BOX}/`]);
    const entry = serve({ ...HEALTHY, [`${BOX}/src/main.tsx`]: 502 });
    await expect(probeSandboxDevServer(BOX, entry.fetchFn)).resolves.toBe(false);
    expect(entry.urls).not.toContain(`${BOX}/src/App.tsx`);
  });

  it("follows the app's own modules deeper (App -> its sections), never reads a pre-bundled dependency", async () => {
    let depRead = false;
    const deep = {
      ...HEALTHY,
      [`${BOX}/src/App.tsx`]: () => new Response(`import Hero from "/src/components/sections/Hero.tsx";\nimport Home from "/src/pages/Home.tsx";`, { status: 200 }),
      [`${BOX}/src/pages/Home.tsx`]: () => new Response(`import { Button } from "/src/components/ui/button.tsx";`, { status: 200 }),
      [`${BOX}/src/components/sections/Hero.tsx`]: 200,
      [`${BOX}/src/components/ui/button.tsx`]: 200,
      [`${BOX}/node_modules/.vite/deps/react.js?v=7c1a2b`]: () => {
        const body = new Response(`import "/src/never-read.ts";`, { status: 200 });
        const text = body.text.bind(body);
        body.text = async () => {
          depRead = true;
          return text();
        };
        return body;
      },
    };
    const { fetchFn, urls } = serve(deep);
    await expect(probeSandboxDevServer(BOX, fetchFn)).resolves.toBe(true);
    expect(urls).toContain(`${BOX}/src/components/ui/button.tsx`);
    expect(depRead).toBe(false);
    expect(urls).not.toContain(`${BOX}/src/never-read.ts`);
    await expect(probeSandboxDevServer(BOX, serve({ ...deep, [`${BOX}/src/components/ui/button.tsx`]: 502 }).fetchFn)).resolves.toBe(false);
  });

  it("a cyclic or huge graph stays bounded", async () => {
    const many = Array.from({ length: 100 }, (_, i) => `import "/src/m${i}.ts";`).join("\n");
    const map: Record<string, number | (() => Response)> = { ...HEALTHY, [`${BOX}/src/App.tsx`]: () => new Response(`import "/src/main.tsx";\n${many}`, { status: 200 }) };
    for (let i = 0; i < 100; i++) map[`${BOX}/src/m${i}.ts`] = () => new Response(`import "/src/App.tsx";`, { status: 200 });
    const { fetchFn, urls } = serve(map);
    await expect(probeSandboxDevServer(BOX, fetchFn)).resolves.toBe(true);
    expect(urls.length).toBeLessThanOrEqual(1 + 48);
  });

  it("a network error anywhere is 'not yet', never a throw", async () => {
    const fetchFn: ProbeFetch = async (url) => {
      if (url === `${BOX}/src/App.tsx`) throw new TypeError("fetch failed");
      return serve(HEALTHY).fetchFn(url, {});
    };
    await expect(probeSandboxDevServer(BOX, fetchFn)).resolves.toBe(false);
  });
});
