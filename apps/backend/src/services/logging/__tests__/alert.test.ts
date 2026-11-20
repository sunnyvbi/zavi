import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const logEventMock = vi.fn((_input: unknown) => Promise.resolve());
const confirmedMock = vi.fn(async (_input: unknown): Promise<{ ok: boolean; error?: string }> => ({ ok: true }));
vi.mock("../logEvent", () => ({
  logEvent: (input: unknown) => logEventMock(input),
  logEventConfirmed: (input: unknown) => confirmedMock(input),
}));

import { alert, deliverOpsAlert } from "../alert";

describe("alert() — env-gated Slack fan-out", () => {
  const origWebhook = process.env.PRAXIS_ALERTS_SLACK_WEBHOOK;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchMock: ReturnType<typeof vi.fn<any[], any>>;

  beforeEach(() => {
    logEventMock.mockClear();
    fetchMock = vi.fn(() => Promise.resolve({ ok: true, status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    delete process.env.PRAXIS_ALERTS_SLACK_WEBHOOK;
  });

  afterEach(() => {
    if (origWebhook === undefined) delete process.env.PRAXIS_ALERTS_SLACK_WEBHOOK;
    else process.env.PRAXIS_ALERTS_SLACK_WEBHOOK = origWebhook;
    vi.restoreAllMocks();
  });

  it("no-ops the network when the webhook env var is unset (log-only)", async () => {
    const errSpy = vi.spyOn(console, "error");
    await alert({ source: "test-src", msg: "failure rate 80% terminal=10" });

    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0][0])).toContain("[ALERT:praxis-alerts]");
    expect(logEventMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no-ops the network when the webhook env var is empty/whitespace", async () => {
    process.env.PRAXIS_ALERTS_SLACK_WEBHOOK = "   ";
    await alert({ source: "test-src", msg: "x" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logEventMock).toHaveBeenCalledTimes(1);
  });

  it("POSTs to the webhook (mock fetch) when the env var is set", async () => {
    process.env.PRAXIS_ALERTS_SLACK_WEBHOOK = "https://hooks.slack.com/services/T/B/XYZ";
    await alert({
      source: "run-failure-rate-canary",
      code: "run_failure_rate",
      tenant_id: "tenant-abc",
      msg: "failure rate 90% terminal=20",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://hooks.slack.com/services/T/B/XYZ");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body as string);
    expect(body.text).toContain("[ALERT:praxis-alerts]");
    expect(body.text).toContain("run-failure-rate-canary");
    expect(body.text).toContain("failure rate 90%");
    expect(logEventMock).toHaveBeenCalledTimes(1);
  });

  it("reads the env var at CALL time (not cached at import)", async () => {
    await alert({ source: "s", msg: "m1" });
    expect(fetchMock).not.toHaveBeenCalled();
    process.env.PRAXIS_ALERTS_SLACK_WEBHOOK = "https://hooks.slack.com/services/A/B/C";
    await alert({ source: "s", msg: "m2" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never throws when the webhook POST rejects", async () => {
    process.env.PRAXIS_ALERTS_SLACK_WEBHOOK = "https://hooks.slack.com/services/T/B/XYZ";
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    await expect(
      alert({ source: "s", msg: "m" }),
    ).resolves.toBeUndefined();
    expect(logEventMock).toHaveBeenCalledTimes(1);
  });

  it("never throws when the webhook returns a non-2xx", async () => {
    process.env.PRAXIS_ALERTS_SLACK_WEBHOOK = "https://hooks.slack.com/services/T/B/XYZ";
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    await expect(alert({ source: "s", msg: "m" })).resolves.toBeUndefined();
    expect(logEventMock).toHaveBeenCalledTimes(1);
  });

  it("scrubs connection-string-like content out of the message (defense-in-depth)", async () => {
    process.env.PRAXIS_ALERTS_SLACK_WEBHOOK = "https://hooks.slack.com/services/T/B/XYZ";
    await alert({
      source: "s",
      msg: "scan failed: postgres://user:pw@host:5432/db unreachable",
    });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.text).not.toContain("postgres://");
    expect(body.text).not.toContain("user:pw@host");
    expect(body.text).toContain("‹conn›");
  });

  it("pages Slack without waiting for the database write (outage case)", async () => {
    process.env.PRAXIS_ALERTS_SLACK_WEBHOOK = "https://hooks.slack.com/services/T/B/XYZ";
    let finishWrite!: () => void;
    logEventMock.mockImplementationOnce(() => new Promise<void>((r) => (finishWrite = r)));
    const done = alert({ msg: "db down", source: "canary" });
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    finishWrite();
    await done;
  });
});

describe("deliverOpsAlert", () => {
  const origWebhook = process.env.PRAXIS_ALERTS_SLACK_WEBHOOK;
  beforeEach(() => {
    logEventMock.mockClear();
    confirmedMock.mockReset();
    confirmedMock.mockResolvedValue({ ok: true });
    delete process.env.PRAXIS_ALERTS_SLACK_WEBHOOK;
    global.fetch = vi.fn(() => Promise.resolve({ ok: true, status: 200 })) as unknown as typeof fetch;
  });
  afterEach(() => {
    if (origWebhook === undefined) delete process.env.PRAXIS_ALERTS_SLACK_WEBHOOK;
    else process.env.PRAXIS_ALERTS_SLACK_WEBHOOK = origWebhook;
  });
  const input = { source: "cgo.note", code: "note_items_failed", tenant_id: null, msg: "run=x" };

  it("no webhook: ok only after the log row is written, on every attempt", async () => {
    expect(await deliverOpsAlert(input, { log: false })).toEqual({ ok: true, error: "no_webhook" });
    expect(confirmedMock).toHaveBeenCalledTimes(1);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("no webhook: a failed log write is reported, so the outbox retries it", async () => {
    confirmedMock.mockResolvedValueOnce({ ok: false, error: "insert failed" });
    expect(await deliverOpsAlert(input)).toEqual({ ok: false, error: "log_write_failed: insert failed" });
  });

  it("with a webhook: the log row is awaited on the first attempt only, and the POST decides", async () => {
    process.env.PRAXIS_ALERTS_SLACK_WEBHOOK = "https://hooks.slack.com/services/T/B/x";
    expect(await deliverOpsAlert(input)).toEqual({ ok: true });
    expect(logEventMock).toHaveBeenCalledTimes(1);
    expect(await deliverOpsAlert(input, { log: false })).toEqual({ ok: true });
    expect(logEventMock).toHaveBeenCalledTimes(1);
    expect(confirmedMock).not.toHaveBeenCalled();
  });
});
