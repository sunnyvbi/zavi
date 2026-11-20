import { expect, it } from "vitest";
import { linkedinTrackingLinkTool as tool } from "../linkedin_tracking_link";
const run = async (input: unknown) => await tool.execute({tenant_id:"tenant",log:()=>{}},input) as {url:string;tags:Record<string,string>;preserved:string[];note:string};
it("preserves the homepage, existing query and fragment while distinguishing each post", async () => {
 const urls = await Promise.all(["story","overspend","product"].map(post=>run({url:"https://example.com/?ref=founder#start",campaign:"weekly-launch",post})));
 expect(new Set(urls.map(r=>r.url)).size).toBe(3);
 for (const r of urls) {const url=new URL(r.url);expect(url.pathname).toBe('/');expect(url.hash).toBe('#start');expect(url.searchParams.get('ref')).toBe('founder');expect(r.tags.utm_source).toBe('linkedin');expect(r.tags.utm_medium).toBe('organic_social');}
});
it("preserves existing tags and warns rather than silently reattributing them", async()=>{
 const r=await run({url:"https://example.com/?utm_source=existing&utm_content=owned",campaign:"launch",post:"new"});
 expect(r.tags).toMatchObject({utm_source:"existing",utm_content:"owned"});expect(r.preserved).toEqual(['utm_source','utm_content']);expect(r.note).toContain('preserved');
});
it.each(['javascript:alert(1)','https://user:pass@example.com'])('refuses inappropriate destinations: %s',async url=>{
 await expect(run({url,campaign:'launch',post:'story'})).rejects.toBeTruthy();
});
