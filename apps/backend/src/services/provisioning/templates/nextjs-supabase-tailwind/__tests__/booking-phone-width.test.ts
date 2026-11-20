import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import { chromium, type Browser } from "playwright-core";
import { TEMPLATE_FILES as NEXT } from "../template-files.generated";
import { TEMPLATE_FILES as VITE } from "../../vite-react-supabase/template-files.generated";
import { TEMPLATE_FILES as ZAVI } from "../../vite-react-zavi/template-files.generated";
import { buildStarterFiles } from "../../starters";
import nextTailwind from "../files/tailwind.config";
import viteTailwind from "../../vite-react-supabase/files/tailwind.config";
import zaviTailwind from "../../vite-react-zavi/files/tailwind.config";

const DAYS = Array.from({ length: 15 }, (_, i) => `Oct ${i + 6}`);

const BOOKING_PAGE = `<main class="mx-auto max-w-3xl px-5 py-10">
<h1 class="text-3xl font-bold">Book an appointment</h1>
<form class="mt-8 space-y-8">
<fieldset><legend class="text-sm font-semibold uppercase">2. Day</legend>
<div id="days" class="mt-3 flex gap-2 overflow-x-auto pb-2">
${DAYS.map((d) => `<button type="button" class="day min-w-[92px] shrink-0 rounded-xl border px-3 py-2 text-center text-sm"><span class="block font-semibold">Tue</span><span class="block text-xs">${d}</span></button>`).join("")}
</div></fieldset>
<fieldset id="details" class="grid gap-4 sm:grid-cols-2"><legend class="mb-3 text-sm font-semibold uppercase">4. Your details</legend>
<label class="text-sm font-medium">Your name<input id="name" class="mt-1 w-full rounded-lg border px-3 py-2" name="name"/></label>
</fieldset>
<button id="submit" type="submit" class="w-full rounded-xl px-5 py-3">Book</button>
</form>
</main>`;

const hasChromium = existsSync(chromium.executablePath());

async function compile(css: string, config: object): Promise<string> {
  const result = await postcss([tailwindcss({ ...config, content: [{ raw: BOOKING_PAGE, extension: "html" }] } as never)]).process(css, {
    from: undefined,
  });
  return result.css;
}

describe.skipIf(!hasChromium)("generated booking page on a phone (real Chromium, the template's own base CSS)", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser?.close();
  });

  const cases: Array<[string, () => string, object]> = [
    ["nextjs-supabase-tailwind app/globals.css", () => NEXT["app/globals.css"], nextTailwind],
    ["nextjs landing starter app/globals.css", () => buildStarterFiles("landing", { visitorSafe: true })["app/globals.css"], nextTailwind],
    ["vite-react-supabase src/index.css", () => VITE["src/index.css"], viteTailwind],
    ["vite-react-zavi src/index.css", () => ZAVI["src/index.css"], zaviTailwind],
  ];

  for (const [name, css, config] of cases) {
    for (const width of [375, 390]) {
      it(`${name} at ${width}px: the day row scrolls inside the form and the page never gets wider than the phone`, async () => {
        const styles = await compile(css(), config);
        const page = await browser.newPage({ viewport: { width, height: 812 } });
        try {
          await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${styles}</style></head><body>${BOOKING_PAGE}</body></html>`);
          const m = await page.evaluate(() => {
            const row = document.getElementById("days") as HTMLElement;
            const fieldset = row.closest("fieldset") as HTMLElement;
            const days = row.querySelectorAll<HTMLElement>(".day");
            const last = days[days.length - 1];
            const before = {
              docScroll: document.documentElement.scrollWidth,
              fieldsetRight: fieldset.getBoundingClientRect().right,
              rowClient: row.clientWidth,
              rowScroll: row.scrollWidth,
              inputRight: (document.getElementById("name") as HTMLElement).getBoundingClientRect().right,
              submitRight: (document.getElementById("submit") as HTMLElement).getBoundingClientRect().right,
            };
            row.scrollLeft = row.scrollWidth;
            const lastRect = last.getBoundingClientRect();
            return { ...before, lastLeft: lastRect.left, lastRight: lastRect.right };
          });
          expect(m.fieldsetRight).toBeLessThanOrEqual(width);
          expect(m.docScroll).toBeLessThanOrEqual(width);
          expect(m.inputRight).toBeLessThanOrEqual(width);
          expect(m.submitRight).toBeLessThanOrEqual(width);
          expect(m.rowScroll).toBeGreaterThan(m.rowClient);
          expect(m.lastLeft).toBeGreaterThanOrEqual(0);
          expect(m.lastRight).toBeLessThanOrEqual(width);
        } finally {
          await page.close();
        }
      });
    }
  }
});
