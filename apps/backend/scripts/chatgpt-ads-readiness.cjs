const e=process.env;
const key=e.STRIPE_ADS_SECRET_KEY?.trim()||e.STRIPE_PLATFORM_SECRET_KEY?.trim()||'';
const mode=key.match(/^(?:sk|rk)_(test|live)_/)?.[1]||'unconfigured';
const tables=['ads_wallets','ads_wallet_orders','ads_campaign_funding','ads_creative_uploads','ads_resource_bindings','ads_conversion_sources'];
let failed=false;
function report(name,ok,detail){console.log(`${ok?'PASS':'BLOCKED'} ${name}: ${detail}`);if(!ok)failed=true;}
async function main(){
 report('Stripe API key',mode!=='unconfigured',mode);
 report('Ads webhook secret',!!e.STRIPE_ADS_WEBHOOK_SECRET?.trim(),'value is never printed');
 report('Checkout return URL',!!e.PRAXIS_PUBLIC_BASE,'PRAXIS_PUBLIC_BASE must match this environment');
 for(const table of tables){
  try{const r=await fetch(`${e.SUPABASE_URL}/rest/v1/${table}?select=*&limit=0`,{headers:{apikey:e.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${e.SUPABASE_SERVICE_ROLE_KEY}`},signal:AbortSignal.timeout(10000)});report(`Table ${table}`,r.ok,`HTTP ${r.status}`);}catch{report(`Table ${table}`,false,'database request failed');}
 }
 try{
  const r=await fetch('https://api.ads.openai.com/v1/ad_account',{headers:{Authorization:`Bearer ${e.OPENAI_ADS_API_KEY}`},signal:AbortSignal.timeout(10000)});const a=await r.json();
  report('Advertiser review',r.ok&&a.status==='active'&&a.review?.status==='approved',`HTTP ${r.status}; active/approved required`);
  const host=v=>{try{return new URL(v).hostname.toLowerCase().replace(/^www\./,'');}catch{return null;}};
  report('Reviewed advertiser website',!!host(e.CHATGPT_ADS_ADVERTISER_WEBSITE)&&host(e.CHATGPT_ADS_ADVERTISER_WEBSITE)===host(a.url),'configured website must match the advertiser');
 }catch{report('Advertiser account',false,'account request failed');}
 const target=process.argv.find(v=>v.startsWith('--url='))?.slice(6);
 if(target){
  const url=new URL('/api/webhooks/stripe/ads',target);
  if(url.protocol!=='https:'&&!['127.0.0.1','localhost'].includes(url.hostname))throw new Error('Use HTTPS for a remote backend');
  const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(10000)});
  report('Deployed ads webhook',r.status===400,`unsigned request returned HTTP ${r.status}; a real signed Stripe delivery must still return 2xx`);
 }
 console.log(`Funding flag: ${!['false','0'].includes(String(e.CHATGPT_ADS_FUNDING_ENABLED??'').trim().toLowerCase())?'on':'off'}; serving flag: ${e.CHATGPT_ADS_SERVING_APPROVED==='true'?'on':'off'}`);
 console.log('These checks do not verify signed delivery, live payment processing, provider billing, or individual ad approval. Complete the documented integration tests before serving.');
 process.exitCode=failed?1:0;
}
main().catch(()=>{console.error('Readiness check could not complete. No payment or ad activation was attempted.');process.exitCode=1;});
