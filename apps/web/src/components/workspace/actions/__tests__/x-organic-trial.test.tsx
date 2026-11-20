// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChannelActionCard } from "../ChannelActionCard";
import { platformFor } from "../platforms";
import { makeAction } from "./fixtures";
afterEach(cleanup);
it("three organic posts are individually copyable without future ad blanks", () => {
  const parts=["What makes booking difficult?","What would make your next trip easier?","Which travel task wastes the most time?"].map((content,i)=>({label:`Post ${i+1}`,content}));
  const a=makeAction("text_post",{channel_slug:"x_ads",title:"Publish three organic posts",card_kind:"copy_to_site",primary_label:"Copy post",done_label:"I posted them",body:{step:{title:"Publish three organic posts",body:"Zavi will compare replies after all three posts are live for three days.",deliverable:{kind:"post",label:"Three posts",content:parts.map(p=>p.content).join("\n\n"),parts,presentation:{type:"x_organic_trial"}}}}});
  render(<ChannelActionCard action={a} platform={platformFor("x_ads")} handlers={{onSetStatus:vi.fn(),onRedo:vi.fn(),onApprove:vi.fn(),onOpenChat:vi.fn()}} />);
  expect(screen.queryByText("Fill these in first")).toBeNull();
  expect(screen.queryByRole("button",{name:/Copy ad/})).toBeNull();
  for(const p of parts){
    fireEvent.click(screen.getByRole("tab",{name:p.label}));
    expect(screen.getByText(p.content)).toBeTruthy();
    expect(screen.getByRole("button",{name:"Copy post"})).not.toHaveProperty("disabled",true);
  }
});
