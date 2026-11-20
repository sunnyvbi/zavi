import { describe, it } from "vitest";
import sharp from "sharp";
import { writeFileSync } from "node:fs";
import { composeSocialImage, SOCIAL_LAYOUTS } from "../compose";

const dir = process.env.SOCIAL_IMAGE_PREVIEW_DIR;

describe.skipIf(!dir)("preview dump", () => {
  it("writes one png per layout", async () => {
    const plate = await sharp({
      create: { width: 1080, height: 1350, channels: 3, background: "#2f4858" },
    }).png().toBuffer();
    for (const layout of SOCIAL_LAYOUTS) {
      const { png } = await composeSocialImage({
        plate,
        layout,
        aspect: "4:5",
        tokens: { primary: "#027bff", accent: "#ff5a1f", bg: "#ffffff", text: "#191919" },
        slots: {
          eyebrow: "New in Austin",
          headline: "$25 OFF|ANY RENTAL",
          sub: "Book with a local host",
          badge: "CODE: HAPPYAUG25",
          foot: "Ends Mon Aug 25",
        },
      });
      writeFileSync(`${dir}/layout-${layout}.png`, png);
    }
  });
});
