declare module "jsdom" {
  export type JSDOMOptions = {
    url?: string;
    referrer?: string;
    runScripts?: "outside-only" | "dangerously";
  };
  export class JSDOM {
    constructor(html?: string, options?: JSDOMOptions);
    readonly window: Window & typeof globalThis;
  }
}
