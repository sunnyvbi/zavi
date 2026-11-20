const {chromium}=require('playwright-core');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.ADS_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
  await page.goto('http://127.0.0.1:4318');
  await page.getByRole('button',{name:'Create campaign',exact:true}).click();
  await page.getByLabel('Name',{exact:true}).fill('Local conversion launch');
  await page.getByRole('combobox',{name:/Objective/}).selectOption('conversions');
  await page.getByRole('combobox',{name:/Conversion event/}).selectOption('local_event');
  await page.getByRole('combobox',{name:/Budget type/}).selectOption('daily');await page.getByRole('spinbutton').fill('25');
  const local=d=>new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);
  const start=new Date(Date.now()+3600000),end=new Date(start.getTime()+86400000);
  await page.getByLabel('Start time',{exact:true}).fill(local(start));await page.getByLabel('End time',{exact:true}).fill(local(end));
  await page.getByLabel('Target countries',{exact:false}).fill('US');
  await page.getByLabel('Include locations search').fill('California');await page.getByRole('button',{name:'Search',exact:true}).first().click();
  await page.getByRole('button',{name:'Add California, United States'}).click();
  await page.getByRole('button',{name:'Create paused campaign',exact:true}).click();
  await page.getByRole('button',{name:'Add ad group',exact:true}).click();await page.getByRole('textbox',{name:'Name',exact:true}).last().fill('Conversion intent');
  await page.getByRole('combobox',{name:/Bid strategy/}).selectOption('maximize_conversions');await page.getByRole('button',{name:'Save paused',exact:true}).click();
  await page.getByRole('button',{name:'Add ad',exact:true}).click();
  await page.getByRole('textbox',{name:'Name',exact:true}).last().fill('Signup card');
  await page.getByLabel('Title (3–50 characters)').fill('Find your next car');await page.getByLabel('Ad copy (up to 100 characters)').fill('Browse available rentals and sign up.');
  await page.getByLabel('Sending visitors to').fill('https://example.com/signup');await page.getByLabel('Image URL',{exact:true}).fill('https://example.com/car.jpg');
  await page.getByLabel('Tracking',{exact:true}).fill('utm_campaign={campaign_id}&click_id={oppref}');await page.getByRole('button',{name:'Save paused',exact:true}).click();
  await page.getByText('paused · Review: in_review').waitFor();
  await page.getByRole('button',{name:'Edit group',exact:true}).click();await page.getByRole('combobox',{name:/Bid strategy/}).selectOption('fixed_bid');
  await page.getByLabel('Conversion bid (CPA) (USD)').fill('20');await page.getByRole('button',{name:'Save paused',exact:true}).click();
  await page.screenshot({path:'/tmp/ads-capabilities-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:'/tmp/ads-capabilities-mobile.png',fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
  const state=await (await page.request.get('http://127.0.0.1:4318/sandbox/state')).json();
  const c=state.payload.campaigns.find(c=>c.name.endsWith('Local conversion launch'));assert.equal(c.status,'paused');assert.equal(c.bidding_type,'conversions');assert.equal(c.budget.daily_spend_limit_micros,25000000);assert.deepEqual(c.conversion_event_setting_ids,['local_event']);assert.deepEqual(c.targeting.locations.include,[{id:'2000043'}]);
  assert.deepEqual(errors,[]);console.log('PASS: conversion event, daily schedule, geo search, automatic and fixed CPA bidding, creative review/tracking, desktop/mobile, no JS errors.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
