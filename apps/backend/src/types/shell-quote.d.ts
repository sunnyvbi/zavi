declare module "shell-quote" {
  export type ParseEntry =
    | string
    | { op: string }
    | { op: "glob"; pattern: string }
    | { comment: string };
  export function parse(
    cmd: string,
    env?: Record<string, string> | ((key: string) => string | undefined),
    opts?: { escape?: string },
  ): ParseEntry[];
  export function quote(args: ReadonlyArray<string>): string;
}
