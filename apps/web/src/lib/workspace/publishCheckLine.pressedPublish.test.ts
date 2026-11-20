import { describe, expect, it } from "vitest";
import STEPS from "../../../../backend/src/routes/workspace/__tests__/fixtures/pressed-publish-fix-pass.json";
import { readBuildPublish } from "@/lib/workspace/buildPublish";
import { publishCheckLine } from "@/lib/workspace/buildFraming";

const line = (payload: unknown) => publishCheckLine(readBuildPublish(payload as never));

describe("what the card says for each build-status publish payload of a pressed publish's fix pass", () => {
  it("only the running fix pass says we're fixing it; the stopped publish says the final check failed; live and plain publishing say neither", () => {
    expect(line(STEPS.running)).toBeNull();
    expect(line(STEPS.repairPending)).toBe("Publishing stopped: the final check failed, we're fixing it.");
    expect(line(STEPS.repairSettled)).toBeNull();
    expect(line(STEPS.live)).toBeNull();
    expect(line(STEPS.failed)).toBe("Publishing stopped: the final check failed.");
  });
});
