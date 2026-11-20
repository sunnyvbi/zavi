import { readFileSync, writeFileSync } from "node:fs";
import * as engMod from "../dist/src/services/agents/engine/openai-engine.js";
import * as so from "../dist/src/services/agents/structured-output.js";
const OpenAIAgentEngine = engMod.OpenAIAgentEngine;
const toFmt = so.toOutputFormatJsonSchema;
const MODEL = process.env.PRAXIS_PARITY_OPENAI_MODEL || "gpt-5.5";
const slug = process.env.TUNE_SLUG;
const task = process.env.TUNE_TASK;
const addFile = process.env.TUNE_ADDENDUM || "";
const persona = readFileSync(`src/agents/${slug}/agent.md`,"utf8").split(/^---\s*$/m).slice(2).join("---").trim().slice(0,6000);
let addendum = ""; try { if (addFile) addendum = readFileSync(addFile,"utf8"); } catch {}
const sys = persona + (addendum ? "\n\n## OPENAI ENGINE ADDENDUM (provider-specific reinforcement)\n" + addendum : "");
function rendered(text){ try{ const o=JSON.parse(text); return o.rendered_markdown || (o.decision&&JSON.stringify(o.decision)) || text; }catch{ return text; } }
let text="",err=null;
try{
  const fmt = toFmt(slug);
  const events=[];
  const spec={systemPrompt:sys,userPrompt:task,model:MODEL,maxTurns:2,tools:[],resume:null,abort:new AbortController(),dispatchTool:async()=>({is_error:false,content:"",ms:0}),onEvent:e=>events.push(e),...(fmt?{outputJsonSchema:fmt}:{})};
  for await (const _ of new OpenAIAgentEngine().run(spec)) void _;
  text = events.filter(e=>e.type==="text_delta").map(e=>e.text).join("");
}catch(e){err=e.message||String(e);}
writeFileSync(process.env.TUNE_OUT || "/tmp/oai-tune/out.txt", err?("ERR: "+err):rendered(text));
console.log(slug+": "+(err?("ERR "+err.slice(0,80)):(rendered(text).length+"c ok")));
