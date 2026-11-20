
export const PUBLIC_LANE_KEY = "launch-video-public";

export const PUBLIC_RENDER_CONCURRENCY = 4;

export type RenderLaneInput = {
  delivery?: "slack" | "web" | null;
  tenant_id?: string | null;
  run_id: string;
  job_id?: string | null;
};

export type RenderLaneKeys = {
  tenant_lane_key: string;
  public_lane_key: string;
};

export function renderLaneKeys(input: RenderLaneInput): RenderLaneKeys {
  const runId = input.run_id;
  if (input.delivery === "web") {
    const jobId = input.job_id || runId;
    return { tenant_lane_key: `job:${jobId}`, public_lane_key: PUBLIC_LANE_KEY };
  }
  return {
    tenant_lane_key: input.tenant_id || `run:${runId}`,
    public_lane_key: `run:${runId}`,
  };
}
