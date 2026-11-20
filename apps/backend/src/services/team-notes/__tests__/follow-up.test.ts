import { describe, it, expect } from "vitest";
import { classifyFollowUp } from "../follow-up";

const PREV_USER = "How many signups did we get from Meta ads last week?";
const PREV_REPLY = "You got 42 signups from Meta ads last week.";
const c = (next: string, prevUser: string | null = PREV_USER, prevReply: string | null = PREV_REPLY, allowRephrase = true) =>
  classifyFollowUp({ next, prevUser, prevReply, rephraseSimilarity: 0.6, allowRephrase });

describe("classifyFollowUp: MUST flag", () => {
  it.each([
    "No, that's wrong",
    "no. that is not what I asked",
    "No, it was 12 not 42",
    "That's wrong, check again",
    "that's not right",
    "This is incorrect",
    "Wrong. It was 12 signups",
    "You said 42 but the dashboard shows 12",
    "you said Q2, I asked about Q3",
    "Not what I asked",
    "That's not what I meant",
    "I said last week, not last month",
    "I asked for Q3",
    "You didn't answer my question",
    "you ignored the date range",
    "Still wrong",
    "try again",
    "Please try again, that's not it",
    "Why did you pull Google data?",
    "That didn't work",
    "stop, that's the wrong account",
  ])("correction: %s", (next) => {
    expect(c(next)).toBe("correction");
  });

  it("near-duplicate rephrase of the previous ask", () => {
    expect(c("How many signups did we get from our Meta ads last week?")).toBe("rephrase");
    expect(c(PREV_USER)).toBe("rephrase");
  });
});

describe("classifyFollowUp: MUST NOT flag", () => {
  it.each([
    "no",
    "No",
    "no problem",
    "No worries, thanks!",
    "No, that's great",
    "no that's perfect, thanks",
    "Nope, that's exactly it",
    "No thanks, that's all",
    "no need, looks good",
    "No rush",
    "No, you're right",
    "No, agreed",
    "No, I understand",
    "No, makes sense",
    "No, go ahead",
    "not bad!",
    "You said you'd draft the email, now send it",
    "you said 42 signups, now break that down by campaign",
    "You told me to connect Stripe. Done, what next?",
    "You said 42, actually that's great",
    "I said yes",
    "I said thanks",
    "Can you try again tomorrow when the data is in?",
    "Try again tomorrow when the data is available",
    "try again later",
    "Let's try again next week",
    "try again after the campaign ends",
    "\"No, that's wrong\" is what my customer wrote. Draft a polite reply",
    "Write a post titled 'That's not what I asked for: 5 support mistakes'",
    "My cofounder keeps saying \"you didn't answer my question\" in standups",
    "Great, now do the same for Google",
    "thanks",
    "ok",
    "yes",
    "go ahead",
    "continue",
    "Do the same for last month",
    "What about TikTok?",
    "Is that wrong in the Meta dashboard too, or just ours?",
    "stop when you have the top 3",
  ])("not a correction: %s", (next) => {
    expect(c(next)).toBeNull();
  });

  it("does not treat an answer to the agent's own question as a rephrase", () => {
    expect(c(PREV_USER, PREV_USER, "Which week do you mean, last week or this week?")).toBeNull();
  });

  it("short messages are never rephrases", () => {
    expect(c("signups?", "signups?")).toBeNull();
  });

  it("no previous ask: never a rephrase", () => {
    expect(c(PREV_USER, null)).toBeNull();
  });

  it("allowRephrase=false (barge-in): repeating the ask while it streams is not flagged", () => {
    expect(c(PREV_USER, PREV_USER, null, false)).toBeNull();
    expect(c("No, that's wrong", PREV_USER, null, false)).toBe("correction");
  });
});

describe("classifyFollowUp: frustration (MUST flag)", () => {
  it("the motivating message", () => {
    expect(c("Okay, this is happening repeatedly 34 times. I don't want to trust you anymore")).toBe("frustration");
  });

  it.each([
    "you keep doing the same thing again",
    "how many times do I have to tell you",
    "this is useless",
    "This keeps happening",
    "It happened 5 times in a row",
    "I can't trust you with this",
    "I can't trust you because you don't listen",
    "It keeps failing repeatedly",
    "I do not trust your numbers anymore",
    "I've lost all trust in you",
    "seriously?",
    "Seriously, why",
    "are you kidding me",
    "ridiculous",
    "that's ridiculous",
    "stop doing that",
    "same mistake as yesterday",
    "it's still not working",
    "still not fixed",
    "every time I ask you get it wrong",
    "it fails every time",
    "I give up",
    "this is a waste of time",
    "you're wasting my time",
    "ugh, again",
    "not again",
    "you did it again",
    "it failed again",
    "went wrong again",
    "over and over with the same query",
  ])("frustration: %s", (next) => {
    expect(c(next)).toBe("frustration");
  });

  it("frustration also counts during barge-in (no rephrase needed)", () => {
    expect(c("you keep doing the same thing again", PREV_USER, null, false)).toBe("frustration");
  });

  it("a correction stays a correction even when it is also frustrated", () => {
    expect(c("No, that's wrong. this keeps happening")).toBe("correction");
  });
});

describe("classifyFollowUp: frustration (MUST NOT flag)", () => {
  it.each([
    "again, thanks!",
    "thanks again",
    "Thanks again for the help",
    "try it again tomorrow",
    "can you run it again for March",
    "Do it again for Google ads",
    "Draft a reply to this customer email: \"Hi, you keep failing to ship my order on time\"",
    "Reply to this:\n> you keep failing to ship my order\n> this is useless\nKeep it short",
    "How many times did users click the ad last week?",
    "Please check this repeatedly until the status changes",
    "We posted 34 times this month. What happened to engagement?",
    "How many times do we post per week on LinkedIn?",
    "Post it 3 times a week",
    "We posted 34 times this month",
    "Is it 2 times faster than last month?",
    "Is Twitter a waste of time for B2B?",
    "Seriously good work",
    "Remove the useless columns from the sheet",
    "Every time a user signs up, send them a welcome email",
    "you made the deck, now make it again for Q4",
    "What was the number again?",
    "same for last month please",
    "I trust you, go ahead",
  ])("not frustration: %s", (next) => {
    expect(c(next)).not.toBe("frustration");
  });
});
