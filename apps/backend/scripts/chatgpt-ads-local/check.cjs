const {chromium}=require('playwright-core');
const assert=require('node:assert/strict');
(async()=>{
const browser=await chromium.launch({executablePath:process.env.ADS_TEST_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
const page=await browser.newPage({viewport:{width:1440,height:1000}}), errors=[];page.on('pageerror',e=>errors.push(e.message));
page.setDefaultTimeout(10000);
await page.goto('http://127.0.0.1:4318');
await page.getByRole('button',{name:'Create campaign',exact:true}).click();
await page.getByLabel('Name',{exact:true}).fill('Local Upcar launch');
await page.getByRole('spinbutton').fill('100');
await page.getByRole('button',{name:'Create paused campaign',exact:true}).click();
await page.getByRole('button',{name:'Back to campaigns'}).click();
await page.getByRole('switch',{name:'Activate Local Upcar launch'}).waitFor();
await page.getByRole('button',{name:'Simulate $100 top-up',exact:true}).click();
await page.getByText('$100.00',{exact:true}).first().waitFor();
await page.getByRole('button',{name:'Enable test refill'}).click();
await page.getByRole('button',{name:'Turn off auto-refill',exact:true}).waitFor();
await page.getByRole('switch',{name:'Activate Local Upcar launch'}).click();
await page.getByRole('switch',{name:'Pause Local Upcar launch'}).waitFor();
await page.getByRole('button',{name:'Toggle channel lock'}).click();
await page.getByRole('button',{name:'Manage ChatGPT Ads balance and pauses'}).click();
await page.getByRole('button',{name:'Turn off auto-refill',exact:true}).click();
await page.getByRole('button',{name:'Pause Local Upcar launch',exact:true}).click();
await page.getByText('Local Upcar launch · paused',{exact:true}).waitFor();
let response=await page.request.get('http://127.0.0.1:4318/sandbox/state');let state=await response.json();assert.equal(state.wallet.auto_refill_enabled,false);assert.equal(state.payload.campaigns[0].status,'paused');
await page.getByRole('button',{name:'Toggle channel lock'}).click();
await page.getByRole('button',{name:'Dispute $10',exact:true}).click();
await page.getByText('$90.00',{exact:true}).waitFor();
await page.getByRole('button',{name:'Refund latest top-up',exact:true}).click();
await page.getByText('$0.00',{exact:true}).first().waitFor();
await page.getByRole('button',{name:'Fail latest refund',exact:true}).click();
await page.getByText('$90.00',{exact:true}).waitFor();
await page.screenshot({path:'/tmp/ads-local-desktop.png',fullPage:true});
await page.setViewportSize({width:390,height:844});await page.screenshot({path:'/tmp/ads-local-mobile.png',fullPage:true});
assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);assert.deepEqual(errors,[]);
console.log('PASS: real shared UI + routes + wallet SQL; paused create, topup, activation reservation, locked cancellation and pause, partial dispute, refund and failed-refund restoration, mobile width, no JS errors.');
}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
