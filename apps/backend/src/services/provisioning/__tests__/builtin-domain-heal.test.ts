import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  advanceBuiltinDomain,
  resetBuiltinVerifyThrottle,
  BUILTIN_VERIFY_THROTTLE_MS,
  type BuiltinHealDeps,
} from "../builtin-domain-heal";

const T = "b92dcbf1-bac9-457a-af81-0bbe5984339b";
const STUCK = {
  tenant_id: T,
  external_ref: {
    hostname: "mohit-93bd8436.zaviagent.com",
    dns_record_id: null,
    custom_domain_id: "cdm-daqcisgu01pc73fmg6bg",
  },
};

function deps(over: Partial<BuiltinHealDeps> = {}) {
  const d = {
    baseDomain: "zaviagent.com",
    loadHosting: vi.fn(async () => ({
      serviceId: "srv-daqciqs9v7es73cmht40",
      url: "https://mohit-93bd8436.onrender.com",
    })),
    ensureCname: vi.fn(async () => ({ record_id: "cf-rec-1" })),
    renderStatus: vi.fn(async () => "pending" as string | null),
    requestVerify: vi.fn(async () => {}),
    save: vi.fn(async () => {}),
    ...over,
  };
  return d;
}

const RECORDED = {
  tenant_id: T,
  external_ref: {
    ...STUCK.external_ref,
    dns_record_id: "cf-rec-1",
    render_service_id: "srv-daqciqs9v7es73cmht40",
    status: "verifying",
  },
};

describe("advanceBuiltinDomain", () => {
  beforeEach(() => resetBuiltinVerifyThrottle());

  it.each(["www.zaviagent.com", "api.zaviagent.com", "a.b.zaviagent.com", "x.zaviagent.com"])(
    "skips a hostname no label edit could produce (%s): the row is tenant-writable JSON",
    async (hostname) => {
      const d = deps();
      const forged = { tenant_id: T, external_ref: { hostname, status: "verifying" } };
      expect(await advanceBuiltinDomain(forged, d)).toBe("skipped");
      expect(d.ensureCname).not.toHaveBeenCalled();
      expect(d.save).not.toHaveBeenCalled();
    },
  );
  it("writes the missing CNAME to the tenant's Render host, asks Render to verify, and records it as verifying", async () => {
    const d = deps();
    expect(await advanceBuiltinDomain(STUCK, d)).toBe("verifying");
    expect(d.ensureCname).toHaveBeenCalledWith("mohit-93bd8436.zaviagent.com", "mohit-93bd8436.onrender.com");
    expect(d.requestVerify).toHaveBeenCalledWith("srv-daqciqs9v7es73cmht40", "cdm-daqcisgu01pc73fmg6bg");
    expect(d.save).toHaveBeenCalledWith(T, {
      hostname: "mohit-93bd8436.zaviagent.com",
      custom_domain_id: "cdm-daqcisgu01pc73fmg6bg",
      dns_record_id: "cf-rec-1",
      render_service_id: "srv-daqciqs9v7es73cmht40",
      status: "verifying",
    });
  });

  it("flips a row to live once Render has verified it, without rewriting DNS", async () => {
    const d = deps({ renderStatus: vi.fn(async () => "verified") });
    const row = {
      tenant_id: T,
      external_ref: {
        ...STUCK.external_ref,
        dns_record_id: "cf-rec-1",
        render_service_id: "srv-daqciqs9v7es73cmht40",
        status: "verifying",
      },
    };
    expect(await advanceBuiltinDomain(row, d)).toBe("live");
    expect(d.ensureCname).not.toHaveBeenCalled();
    expect(d.loadHosting).not.toHaveBeenCalled();
    expect(d.requestVerify).not.toHaveBeenCalled();
    expect(d.save).toHaveBeenCalledWith(T, { ...row.external_ref, status: "live" });
  });

  it("clears 'Setting up' for a legacy row that already had DNS but never got a status", async () => {
    const d = deps({ renderStatus: vi.fn(async () => "verified") });
    const row = { tenant_id: T, external_ref: { ...STUCK.external_ref, dns_record_id: "cf-old" } };
    expect(await advanceBuiltinDomain(row, d)).toBe("live");
    expect(d.ensureCname).not.toHaveBeenCalled();
    expect(d.save).toHaveBeenCalledWith(T, expect.objectContaining({ status: "live", dns_record_id: "cf-old" }));
  });

  it("never writes our DNS for a hostname outside the built-in zone", async () => {
    const d = deps();
    const row = { tenant_id: T, external_ref: { hostname: "www.mohit.dev", dns_record_id: null } };
    expect(await advanceBuiltinDomain(row, d)).toBe("skipped");
    expect(d.ensureCname).not.toHaveBeenCalled();
    expect(d.save).not.toHaveBeenCalled();
  });

  it("does not claim zaviagent.com lookalikes such as evilzaviagent.com", async () => {
    const d = deps();
    const row = { tenant_id: T, external_ref: { hostname: "x.evilzaviagent.com", dns_record_id: null } };
    expect(await advanceBuiltinDomain(row, d)).toBe("skipped");
    expect(d.ensureCname).not.toHaveBeenCalled();
  });

  it("leaves a live row alone", async () => {
    const d = deps();
    const row = { tenant_id: T, external_ref: { ...STUCK.external_ref, status: "live" } };
    expect(await advanceBuiltinDomain(row, d)).toBe("skipped");
    expect(d.loadHosting).not.toHaveBeenCalled();
    expect(d.save).not.toHaveBeenCalled();
  });

  it("writes nothing when Cloudflare is not configured, so the row is retried later", async () => {
    const d = deps({ ensureCname: vi.fn(async () => ({ record_id: null, skipped: true })) });
    expect(await advanceBuiltinDomain(STUCK, d)).toBe("skipped");
    expect(d.save).not.toHaveBeenCalled();
    expect(d.requestVerify).not.toHaveBeenCalled();
  });

  it("waits while the Render app has no URL yet", async () => {
    const d = deps({ loadHosting: vi.fn(async () => ({ serviceId: "srv-1", url: null })) });
    expect(await advanceBuiltinDomain(STUCK, d)).toBe("skipped");
    expect(d.ensureCname).not.toHaveBeenCalled();
    expect(d.save).not.toHaveBeenCalled();
  });

  it("still records the DNS when Render's verify call fails", async () => {
    const d = deps({ requestVerify: vi.fn(async () => { throw new Error("render 500"); }) });
    expect(await advanceBuiltinDomain(STUCK, d)).toBe("verifying");
    expect(d.save).toHaveBeenCalledWith(T, expect.objectContaining({ dns_record_id: "cf-rec-1" }));
  });

  it("does not rewrite a verifying row that has not changed", async () => {
    const d = deps();
    const row = {
      tenant_id: T,
      external_ref: { ...STUCK.external_ref, dns_record_id: "cf-rec-1", render_service_id: "srv-1", status: "verifying" },
    };
    expect(await advanceBuiltinDomain(row, d)).toBe("verifying");
    expect(d.save).not.toHaveBeenCalled();
  });

  it("asks Render to verify on a poll where DNS is already recorded but Render still says unverified, once per minute per hostname", async () => {
    let t = 1_000_000;
    const d = deps({ now: () => t });
    expect(await advanceBuiltinDomain(RECORDED, d)).toBe("verifying");
    expect(d.requestVerify).toHaveBeenCalledTimes(1);
    expect(d.requestVerify).toHaveBeenCalledWith("srv-daqciqs9v7es73cmht40", "cdm-daqcisgu01pc73fmg6bg");
    t += BUILTIN_VERIFY_THROTTLE_MS - 1;
    await advanceBuiltinDomain(RECORDED, d);
    await advanceBuiltinDomain(RECORDED, d);
    expect(d.requestVerify).toHaveBeenCalledTimes(1);
    t += 1;
    await advanceBuiltinDomain(RECORDED, d);
    expect(d.requestVerify).toHaveBeenCalledTimes(2);
    const other = { tenant_id: T, external_ref: { ...RECORDED.external_ref, hostname: "other-93bd8436.zaviagent.com" } };
    await advanceBuiltinDomain(other, d);
    expect(d.requestVerify).toHaveBeenCalledTimes(3);
    expect(d.save).not.toHaveBeenCalled();
  });

  it("flips to live in the same poll when the verify request lands and Render confirms on re-read", async () => {
    const renderStatus = vi
      .fn<[string, string], Promise<string | null>>()
      .mockResolvedValueOnce("unverified")
      .mockResolvedValueOnce("unverified")
      .mockResolvedValueOnce("verified");
    const d = deps({ renderStatus, now: () => 5 });
    expect(await advanceBuiltinDomain(RECORDED, d)).toBe("live");
    expect(d.requestVerify).toHaveBeenCalledTimes(1);
    expect(d.save).toHaveBeenCalledWith(T, expect.objectContaining({ status: "live" }));
  });

  it("re-points a drifted CNAME on the minute tick and records the repaired record id", async () => {
    const d = deps({ ensureCname: vi.fn(async () => ({ record_id: "cf-rec-2" })), now: () => 5 });
    expect(await advanceBuiltinDomain(RECORDED, d)).toBe("verifying");
    expect(d.loadHosting).toHaveBeenCalledWith(T);
    expect(d.ensureCname).toHaveBeenCalledWith("mohit-93bd8436.zaviagent.com", "mohit-93bd8436.onrender.com");
    expect(d.save).toHaveBeenCalledWith(T, expect.objectContaining({ dns_record_id: "cf-rec-2", status: "verifying" }));
  });

  it("keeps the recorded DNS id when the minute tick finds Cloudflare unconfigured or failing, and still asks Render", async () => {
    const skipped = deps({ ensureCname: vi.fn(async () => ({ record_id: null, skipped: true })), now: () => 5 });
    expect(await advanceBuiltinDomain(RECORDED, skipped)).toBe("verifying");
    expect(skipped.requestVerify).toHaveBeenCalledTimes(1);
    expect(skipped.save).not.toHaveBeenCalled();
    resetBuiltinVerifyThrottle();
    const failing = deps({ ensureCname: vi.fn(async () => { throw new Error("cloudflare 500"); }), now: () => 5 });
    expect(await advanceBuiltinDomain(RECORDED, failing)).toBe("verifying");
    expect(failing.requestVerify).toHaveBeenCalledTimes(1);
    expect(failing.save).not.toHaveBeenCalled();
  });

  const OWN = "srv-daqciqs9v7es73cmht40";
  const VICTIM = "srv-victim00000000000000";
  const VICTIM_HOST = "acme-shop.zaviagent.com";
  const attachedOnlyTo = (service: string, host: string) =>
    vi.fn(async (serviceId: string, idOrHost: string) =>
      serviceId === service && (idOrHost === host || idOrHost.startsWith("cdm-")) ? "verified" : null,
    );

  it("never writes a CNAME for a hostname stored straight through the RPC that Render has not attached to this tenant's service", async () => {
    const d = deps({ renderStatus: attachedOnlyTo(VICTIM, VICTIM_HOST) });
    const forged = { tenant_id: T, external_ref: { hostname: VICTIM_HOST, status: "verifying" } };
    expect(await advanceBuiltinDomain(forged, d)).toBe("skipped");
    expect(d.ensureCname).not.toHaveBeenCalled();
    expect(d.requestVerify).not.toHaveBeenCalled();
    expect(d.save).not.toHaveBeenCalled();
  });

  it("ignores a forged render_service_id that points at another tenant's service", async () => {
    const d = deps({ renderStatus: attachedOnlyTo(VICTIM, VICTIM_HOST) });
    const forged = {
      tenant_id: T,
      external_ref: { hostname: VICTIM_HOST, render_service_id: VICTIM, custom_domain_id: "cdm-victim", status: "verifying" },
    };
    expect(await advanceBuiltinDomain(forged, d)).toBe("skipped");
    expect(d.ensureCname).not.toHaveBeenCalled();
    expect(d.save).not.toHaveBeenCalled();
  });

  it("does not re-point a CNAME on the minute tick for a recorded hostname Render has not attached to this tenant's service", async () => {
    const d = deps({ renderStatus: attachedOnlyTo(VICTIM, VICTIM_HOST), now: () => 5 });
    const forged = {
      tenant_id: T,
      external_ref: { hostname: VICTIM_HOST, dns_record_id: "cf-victim", render_service_id: OWN, status: "verifying" },
    };
    expect(await advanceBuiltinDomain(forged, d)).toBe("verifying");
    expect(d.ensureCname).not.toHaveBeenCalled();
    expect(d.save).not.toHaveBeenCalled();
  });

  it("still writes the CNAME when Render has the hostname attached to this tenant's own service", async () => {
    const d = deps({ renderStatus: vi.fn(async (serviceId: string, idOrHost: string) =>
      serviceId === OWN && idOrHost === "mohit-93bd8436.zaviagent.com" ? "pending" : null,
    ) });
    expect(await advanceBuiltinDomain(STUCK, d)).toBe("verifying");
    expect(d.ensureCname).toHaveBeenCalledWith("mohit-93bd8436.zaviagent.com", "mohit-93bd8436.onrender.com");
  });

  it("does not poke Render again within the minute after it wrote DNS and already asked", async () => {
    let t = 10;
    const d = deps({ now: () => t });
    await advanceBuiltinDomain(STUCK, d);
    expect(d.requestVerify).toHaveBeenCalledTimes(1);
    t += 4_000;
    await advanceBuiltinDomain(RECORDED, d);
    expect(d.requestVerify).toHaveBeenCalledTimes(1);
  });
});
