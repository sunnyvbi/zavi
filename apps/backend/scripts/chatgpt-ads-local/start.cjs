const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync, spawn } = require('node:child_process');
const esbuild = require('esbuild');
const repo = path.resolve(__dirname, '../../../..');
const build = fs.mkdtempSync(path.join(os.tmpdir(), 'zavi-ads-local-'));
const fixture = path.join(__dirname, 'fixtures.ts');
const aliases = Object.fromEntries([
  '@/services/supabase', '@/services/auth/middleware', '@/services/auth/tenant-role',
  '@/services/agents/entitlement', '@/services/channels/lock', '@/services/logging/logEvent',
  '@/services/connectors/chatgpt-ads/http', '@/services/connectors/chatgpt-ads/key-provider',
  '@/services/connectors/chatgpt-ads/creative-upload', '@/services/channels/chatgpt-ads/stripe-client', '@/services/ads-wallet/stripe-client',
].map(p=>[p,fixture]));
(async()=>{
  require.resolve('@electric-sql/pglite');
  await esbuild.build({entryPoints:[path.join(__dirname,'server.ts')],outfile:path.join(build,'server.cjs'),bundle:true,platform:'node',format:'cjs',packages:'external',alias:aliases,tsconfig:path.join(repo,'apps/backend/tsconfig.json'),plugins:[{name:'local-providers-only',setup(b){b.onResolve({filter:/^\.\/(http|key-provider|creative-upload|stripe-client)$/},args=>(args.importer.includes('/chatgpt-ads/') || args.importer.includes('/ads-wallet/'))?{path:fixture}:undefined);}}]});
  await esbuild.build({entryPoints:[path.join(repo,'apps/web/scripts/chatgpt-ads-local.tsx')],outfile:path.join(build,'app.js'),bundle:true,platform:'browser',jsx:'automatic',alias:{'@/lib/api':path.join(__dirname,'browser-api.ts')},define:{'process.env.NODE_ENV':'"development"'},tsconfig:path.join(repo,'apps/web/tsconfig.json')});
  const tailwind=spawnSync(process.execPath,[path.join(repo,'node_modules/tailwindcss/lib/cli.js'),'-c',path.join(repo,'apps/web/tailwind.config.ts'),'-i',path.join(repo,'apps/web/src/app/globals.css'),'--content',`${repo}/apps/web/src/components/workspace/actions/**/*.{ts,tsx},${repo}/apps/web/scripts/chatgpt-ads-local.tsx`,'-o',path.join(build,'style.css')],{cwd:path.join(repo,'apps/web'),stdio:'inherit'});
  if(tailwind.status!==0)throw new Error('Local styles could not be built');
  fs.writeFileSync(path.join(build,'index.html'),'<!doctype html><html style="--font-body:Arial;--font-ui:Arial"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>ChatGPT Ads local test</title><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
  const child=spawn(process.execPath,[path.join(build,'server.cjs')],{stdio:'inherit',env:{PATH:process.env.PATH,NODE_PATH:[path.join(repo,'node_modules'),process.env.NODE_PATH].filter(Boolean).join(path.delimiter),ADS_LOCAL_REPO:repo,ADS_LOCAL_BUILD:build}});
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
  child.on('exit',code=>{fs.rmSync(build,{recursive:true,force:true});process.exitCode=code||0;});
})().catch(e=>{console.error(e.message);console.error('Install the local-only dependency: npm install --prefix /tmp/zavi-chatgpt-sql-test @electric-sql/pglite@0.5.8');process.exitCode=1;});
