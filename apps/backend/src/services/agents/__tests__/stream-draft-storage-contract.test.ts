import { createClient } from "@supabase/supabase-js";
import { expect, it } from "vitest";
import { createStreamDraftEmitter } from "../stream-draft";
it("uses the real Supabase builder for generation admission and fenced writes", async () => {
  const requests: Array<{ url: URL; init: RequestInit }> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)); requests.push({ url, init:init ?? {} });
    return new Response(url.pathname.endsWith("begin_stream_draft_writer") ? "12" : "true", { status:200, headers:{ "Content-Type":"application/json" } });
  };
  const sb=createClient("https://local-test.invalid","test-only-key",{ auth:{persistSession:false,autoRefreshToken:false},global:{fetch} });
  const emitter=createStreamDraftEmitter({runId:"r",tenantId:"t",threadId:null,agentSlug:"operator",sb});
  await emitter.ready(); await emitter.push("Complete answer"); await emitter.finish("complete");
  expect(requests.map(r=>r.url.pathname)).toEqual(["/rest/v1/rpc/begin_stream_draft_writer","/rest/v1/rpc/write_stream_draft"]);
  expect(JSON.parse(String(requests[1].init.body))).toMatchObject({p_run_id:"r",p_tenant_id:"t",p_generation:12,p_seq:1,p_text:"Complete answer",p_status:"complete"});
});
