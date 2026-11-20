import { z } from "zod";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { chatgptAdsGet } from "@/services/connectors/chatgpt-ads/http";
import { getChatgptAdsApiKey } from "@/services/connectors/chatgpt-ads/key-provider";
async function main() {
  const args=process.argv.slice(2); const arg=(key:string)=>args[args.indexOf(key)+1];
  const tenant=z.string().uuid().parse(args.includes("--tenant")?arg("--tenant"):undefined);
  const kind=z.enum(["conversion_event","audience","product_feed"]).parse(args.includes("--kind")?arg("--kind"):undefined);
  const id=z.string().regex(/^[a-zA-Z0-9_-]+$/).parse(args.includes("--id")?arg("--id"):undefined);
  const source=kind==="conversion_event"?z.string().regex(/^[a-zA-Z0-9_-]+$/).parse(args.includes("--source")?arg("--source"):undefined):null;
  const key=await getChatgptAdsApiKey();
  const path=kind==="conversion_event"?"/conversions/event_settings":kind==="audience"?"/custom_audiences":"/feeds";
  let after: string|undefined, found: Record<string,any>|undefined;
  for(let page=0;page<10;page++) {
    const r=await chatgptAdsGet<{data:Record<string,any>[];has_more?:boolean;last_id?:string}>(key,path,{limit:500,after});
    found=r.data?.find(v=>(v.id??v.feed_id)===id);
    if(found||!r.has_more)break;
    if(!r.last_id||r.last_id===after)throw new Error("Provider list is incomplete"); after=r.last_id;
  }
  if(!found||found.archived===true||found.status==="archived")throw new Error("Resource not available in this advertiser account");
  if(kind==="conversion_event"&&(found.archived!==false||found.event_type==="custom"||found.source_ids?.length!==1||found.source_ids[0]!==source))throw new Error("Event/source pair is not eligible");
  const db=tenantClient(asTenantId(tenant));
  const t=await db.from("tenants").select("id").eq("id",tenant).single();
  if(t.error||!t.data)throw new Error("Workspace could not be verified");
  if(!args.includes("--apply")){console.log("Verified provider resource and workspace. No assignment written. Re-run with --apply after confirming this resource belongs to that customer.");return;}
  if(source){
    const r=await db.from("ads_conversion_sources").upsert({source_id:source,tenant_id:tenant},{onConflict:"source_id",ignoreDuplicates:true});if(r.error)throw new Error("Source assignment failed");
    const own=await db.from("ads_conversion_sources").select("source_id").eq("source_id",source).eq("tenant_id",tenant).single();if(own.error||!own.data)throw new Error("Source is assigned to a different workspace");
  }
  const r=await db.from("ads_resource_bindings").upsert({resource_id:id,tenant_id:tenant,kind,source_id:source},{onConflict:"resource_id",ignoreDuplicates:true});if(r.error)throw new Error("Resource assignment failed");
  const own=await db.from("ads_resource_bindings").select("kind,source_id").eq("resource_id",id).eq("tenant_id",tenant).single();
  const row=own.data as {kind:string;source_id:string|null}|null;
  if(own.error||!row||row.kind!==kind||row.source_id!==source)throw new Error("Resource already has a conflicting assignment; nothing was reassigned");
  console.log("Workspace resource assignment verified. Provider eligibility is checked again whenever used.");
}
main().catch(e=>{console.error(e instanceof z.ZodError?"Invalid operator arguments":e instanceof Error?e.message:"Setup failed");process.exitCode=1;});
