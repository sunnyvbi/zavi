const {chromium}=require('playwright-core');
const assert=require('node:assert/strict');
(async()=>{
const browser=await chromium.launch({executablePath:process.env.ADS_TEST_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
 const page=await browser.newPage({viewport:{width:1440,height:1050}}), errors=[];
 page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
 await page.goto('http://127.0.0.1:4318');
 await page.getByRole('button',{name:'Review and create',exact:true}).click();
 await page.getByLabel('Total campaign budget (USD)').waitFor();
 assert.equal(await page.getByLabel('Total campaign budget (USD)').inputValue(),'');
 assert.equal(await page.getByRole('button',{name:'Approve and create paused campaign',exact:true}).isEnabled(),false);
 await page.getByLabel('Total campaign budget (USD)').fill('100');
 await page.getByLabel('Maximum cost-per-click bid (USD)').fill('0.50');
 await page.getByLabel('Target countries').fill('US');
 await page.screenshot({path:'/tmp/ads-action-review-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});
 await page.screenshot({path:'/tmp/ads-action-review-mobile.png',fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
 await page.getByRole('button',{name:'Approve and create paused campaign',exact:true}).click();
 await page.getByText('Zavi made this change in ChatGPT Ads',{exact:true}).waitFor();
 let state=await (await page.request.get('http://127.0.0.1:4318/sandbox/state')).json();
 assert.equal(state.actions[0].exec_status,'executed');assert.equal(state.payload.campaigns.length,1);
 const c=state.payload.campaigns[0]; assert.equal(c.status,'paused');assert.equal(c.budget.lifetime_spend_limit_micros,100000000);
 for(const level of ['ad_group','ad']) {
  const result=await(await page.request.get(`http://127.0.0.1:4318/api/channels/chatgpt_ads/campaigns/${c.id}/entities?level=${level}&days=30`)).json();
  assert.equal(result.rows.length,1);assert.equal(result.rows[0].status,'paused');
 }
 await page.request.post(`http://127.0.0.1:4318/sandbox/actions/${state.actions[0].id}/approve`);
 state=await(await page.request.get('http://127.0.0.1:4318/sandbox/state')).json();assert.equal(state.payload.campaigns.length,1);
 assert.equal(Number(state.wallet.balance_cents),0); assert.equal(state.wallet.auto_refill_enabled,false);
 assert.deepEqual(errors,[]);
 await page.screenshot({path:'/tmp/ads-action-executed-mobile.png',fullPage:true});
 console.log('PASS: desktop/mobile review, blank money inputs, real review SQL + executor against simulated provider, all entities paused, no duplicate on retry, no funding/refill, no browser errors.');
} finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
