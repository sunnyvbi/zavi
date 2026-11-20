import { expect, it } from "vitest";
import { pairedLinkedInDecisionIds } from "../linkedin-paired-decisions";
const d = (id: string, text: string) => ({id, decision_class: "social.publish.v2", social_channel: "linkedin", social_text: text});
it("counts eight cards and their matching staged post as eight pieces of work", () => {
 const cards = Array.from({length: 8}, (_, n) => ({action_type: "text_post", content: `Post ${n}`}));
 const pending = [d("staged", "Post 0")];
 expect(cards.length + pending.length - pairedLinkedInDecisionIds(pending, cards).size).toBe(8);
});
it("does not pair different endings, comments, other platforms or empty copy", () => {
 const prefix = "Same opening. ".repeat(15);
 const rows = [d("different", prefix + "End A"), d("comment", "Reply"), {...d("other", "Post"), social_channel: "x"}, d("empty", "")];
 expect(pairedLinkedInDecisionIds(rows, [{action_type:"text_post",content:prefix+"End B"},{action_type:"reply",content:"Reply"},{action_type:"text_post",content:"Post"}]).size).toBe(0);
});
it("pairs once per card and tolerates harmless whitespace", () => {
 expect([...pairedLinkedInDecisionIds([d("first", "Same\npost"),d("second","Same post")],[{action_type:"text_post",content:"Same post"}])]).toEqual(["first"]);
});

it("retains the pair after a founder edits the saved approval", () => {
 expect([...pairedLinkedInDecisionIds([{...d("edited", "Founder revision"),social_original_text:"Original post"}],[{action_type:"text_post",content:"Original post"}])]).toEqual(["edited"]);
});
