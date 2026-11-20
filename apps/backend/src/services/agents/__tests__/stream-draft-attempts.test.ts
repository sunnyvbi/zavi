import { afterEach, expect, it, vi } from "vitest";
import { createStreamDraftEmitter } from "../stream-draft";
import { draftStore } from "./stream-draft-store.fake";
const opts={runId:"r",tenantId:"t",threadId:null,agentSlug:"operator"};
afterEach(() => { vi.useRealTimers(); });
it("a short retry replaces a long draft, and repeated retries keep public sequence increasing",async()=>{
 const store=draftStore(); let previous=0;
 for(let i=0;i<3;i++) {
  const em=createStreamDraftEmitter({...opts,sb:store.sb}); await em.ready();
  for(let j=0;j<(i===0?8:1);j++){await em.push(i===0?"old".repeat(20):"New answer");for(let n=0;n<12;n++)await Promise.resolve();}
  await em.finish("complete");
  expect(store.stored!.seq).toBeGreaterThan(previous); previous=store.stored!.seq;
  expect(store.stored!.writer_generation).toBe(i+1);
  if(i>0)expect(store.stored!.text).toBe("New answer");
 }
});
it("admission timeout disables this writer even if its response arrives later",async()=>{
 vi.useFakeTimers();let release!:(v:unknown)=>void;
 const rpc=vi.fn(()=>({abortSignal:()=>new Promise(r=>{release=r;})}));
 const em=createStreamDraftEmitter({...opts,sb:{rpc} as never});
 await vi.advanceTimersByTimeAsync(2000); await em.ready();
 release({data:9,error:null});await em.push("answer");await em.finish("complete");
 expect(rpc).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
});
