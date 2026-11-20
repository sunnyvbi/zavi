declare module "jsdom" {
  export class VirtualConsole {
    constructor();
  }
  export class JSDOM {
    constructor(html?: string, options?: Record<string, unknown> & { beforeParse?: (window: any) => void });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readonly window: any;
  }
}
