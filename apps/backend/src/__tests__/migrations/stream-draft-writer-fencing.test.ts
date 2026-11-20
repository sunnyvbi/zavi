import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
const { PGlite } = createRequire(resolve(__dirname, "../../../../../package.json"))("@electric-sql/pglite");
let db: any;
const run="10000000-0000-0000-0000-000000000001", tenant="20000000-0000-0000-0000-000000000001", other="20000000-0000-0000-0000-000000000002", thread="30000000-0000-0000-0000-000000000001";
const migration=readFileSync(resolve(__dirname,"../../../../../supabase/migrations/20261112131156_stream_draft_writer_fencing.sql"),"utf8");
beforeAll(async()=>{
 db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role;
 create table agent_runs(id uuid primary key,tenant_id uuid,agent_slug text,status text);
 create table agent_threads(id uuid primary key,tenant_id uuid);
 create table agent_run_stream_drafts(run_id uuid primary key references agent_runs(id),tenant_id uuid not null,thread_id uuid,agent_slug text,seq bigint default 0,text text,status text,updated_at timestamptz);
 grant all on agent_run_stream_drafts to service_role;
 insert into agent_runs values('${run}','${tenant}','operator','running');
 insert into agent_threads values('${thread}','${other}');`);await db.exec(migration);
},15000);
afterAll(async()=>{await db?.close();});
const begin=async(t=tenant)=>(await db.query("select begin_stream_draft_writer($1,$2) as g",[run,t])).rows[0].g;
const write=async(g:number,s:number,text:string,t=tenant,th:string|null=null,slug="operator")=>(await db.query("select write_stream_draft($1,$2,$3,$4,$5,'complete',$6,$7) as ok",[run,t,g,s,text,th,slug])).rows[0].ok;
it("short retries replace old drafts; rejects late and duplicate writes",async()=>{
 const old=await begin();expect(await write(old,100,"old")).toBe(true);
 const fresh=await begin();expect(fresh).toBeGreaterThan(old);expect(await write(fresh,1,"new")).toBe(true);
 expect(await write(old,101,"late old")).toBe(false);expect(await write(fresh,1,"duplicate")).toBe(false);
 expect(await write(fresh,3,"new final")).toBe(true);expect(await write(fresh,2,"late middle")).toBe(false);
 expect((await db.query("select text,seq,writer_seq from agent_run_stream_drafts")).rows[0]).toMatchObject({text:"new final",seq:3,writer_seq:3});
 const third=await begin();expect(await write(third,1,"third")).toBe(true);expect((await db.query("select seq from agent_run_stream_drafts")).rows[0].seq).toBe(4);
});
it("refuses another tenant, thread or agent",async()=>{
 expect(await begin(other)).toBe(null);const g=await begin();
 expect(await write(g,1,"wrong",other)).toBe(false);expect(await write(g,1,"wrong",tenant,thread)).toBe(false);expect(await write(g,1,"wrong",tenant,null,"cgo")).toBe(false);
 expect((await db.query("select text from agent_run_stream_drafts")).rows[0].text).toBe("third");
});
it("worker RPCs only; legacy direct writes cannot bypass ordering",async()=>{
 for(const role of ["anon","authenticated"]){
  expect((await db.query(`select has_function_privilege('${role}','public.begin_stream_draft_writer(uuid,uuid)','execute') as b,has_function_privilege('${role}','public.write_stream_draft(uuid,uuid,bigint,bigint,text,text,uuid,text)','execute') as w`)).rows[0]).toEqual({b:false,w:false});
 }
 expect((await db.query("select has_table_privilege('service_role','agent_run_stream_drafts','update') as u,has_table_privilege('service_role','agent_run_stream_drafts','insert') as i")).rows[0]).toEqual({u:false,i:false});
 await db.exec("set role service_role");const g=await begin();expect(await write(g,1,"worker")).toBe(true);
 await expect(db.exec("update agent_run_stream_drafts set text='bypass'")).rejects.toThrow();await db.exec("reset role");
});
it("refuses invalid sequences and admission for a terminal run",async()=>{
 expect(await write(0,1,"bad")).toBe(false);expect(await write(1,0,"bad")).toBe(false);
 await db.exec(`update agent_runs set status='success' where id='${run}'`);expect(await begin()).toBe(null);
});
