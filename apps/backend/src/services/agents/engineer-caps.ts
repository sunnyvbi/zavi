
export type EngineerPrCapTier = {
  maxChangedLines: number;
  diffByteCap: number;
  maxPostImageBytes: number;
  maxFiles: number;
};

export const ENGINEER_PR_CAPS_STANDARD: EngineerPrCapTier = {
  maxChangedLines: 5000,
  diffByteCap: 512 * 1024,
  maxPostImageBytes: 2 * 1024 * 1024,
  maxFiles: 100,
};

export const ENGINEER_PR_CAPS_XL: EngineerPrCapTier = {
  maxChangedLines: 15_000,
  diffByteCap: 1024 * 1024,
  maxPostImageBytes: 4 * 1024 * 1024,
  maxFiles: 200,
};

export const ENGINEER_PR_CAPS_PRODUCT_BUILD: EngineerPrCapTier = {
  maxChangedLines: 60_000,
  diffByteCap: 4 * 1024 * 1024,
  maxPostImageBytes: 8 * 1024 * 1024,
  maxFiles: 400,
};

export const ENGINEER_PR_DISPATCH_CEILING: EngineerPrCapTier = ENGINEER_PR_CAPS_XL;

export const RENDERED_MARKDOWN_MAX_CHARS = 4000;
