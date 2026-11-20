import { describe, expect, it } from "vitest";
import { recipeDeliverableSchema } from "@/agents/lib/channel-recipe-step";
import { cardPresentation } from "../card-presentation";
const posts = ["What is the hardest part of planning a trip?", "How do you compare travel options?", "What would make booking simpler?"];
const d = { kind: "post", label: "Three organic posts", content: posts.join("\n\n"), parts: posts.map((content,i)=>({label:`Post ${i+1}`,content})), presentation:{type:"x_organic_trial"} };
describe("organic trial card contract",()=>{
  it("accepts finished posts and gives Copy post instead of Copy ad",()=>{
    const parsed=recipeDeliverableSchema.parse(d);
    const c=cardPresentation({channelSlug:"x_ads",action_type:"text_post",executable:false,deliverableKind:parsed.kind,presentationType:parsed.presentation?.type,hasContent:true,stepBody:null,link:null,siteBuilder:"unknown"});
    expect(c).toMatchObject({card_kind:"copy_to_site",primary_label:"Copy post",owner:"founder"});
    expect(c.how_to.join(" ")).not.toContain("Ads Manager");
  });
  it.each(["[FOUNDER: budget]","[Name]","{{future_url}}","___"])("rejects deferred blank %s",blank=>expect(recipeDeliverableSchema.safeParse({...d,parts:[{label:"Post 1",content:blank},...d.parts.slice(1)]}).success).toBe(false));
  it.each([1,2,4])("requires three posts, not %s",n=>expect(recipeDeliverableSchema.safeParse({...d,parts:Array.from({length:n},(_,i)=>({label:`Post ${i}`,content:`Question ${i}?`}))}).success).toBe(false));
  it("does not accept an ad sheet as the organic stage",()=>expect(recipeDeliverableSchema.safeParse({...d,kind:"ad"}).success).toBe(false));
  it("rejects overlong or duplicate posts",()=>{
    expect(recipeDeliverableSchema.safeParse({...d,parts:d.parts.map(p=>({...p,content:"x".repeat(281)}))}).success).toBe(false);
    expect(recipeDeliverableSchema.safeParse({...d,parts:[d.parts[0],d.parts[0],d.parts[2]]}).success).toBe(false);
  });
  it("ordinary ad cards retain their existing contract",()=>expect(recipeDeliverableSchema.safeParse({...d,kind:"ad",presentation:undefined,content:"Daily budget: [FOUNDER: budget]"}).success).toBe(true));
});
