import { describe, expect, it } from "vitest";
import { asksForCustomerEndorsement, asksPresenterToSpeakAsCustomer, isTestimonialIntent, shouldRedirectTestimonialFromTalkingHead, shouldRefuseGeneratedEndorsement, showsCustomerEndorsement, speaksAsCustomer } from "../generative-video-intake";

describe("testimonial backstop", () => {
  it.each([
    "Make a video of our customer testimonials",
    "a montage of customer reviews",
    "show our 4.9 stars on Google",
    "rated 5 stars by everyone",
    "customer stories from the shop",
  ])("treats %s as a testimonial request", (text) => {
    expect(isTestimonialIntent(text)).toBe(true);
    expect(shouldRedirectTestimonialFromTalkingHead("talking_head", text)).toBe(true);
  });

  it.each([
    "I switched to this gym last year",
    "I’ve been using this serum for a month",
    "I’ve been using it daily",
  ])("hears %s as a customer speaking", (text) => {
    expect(speaksAsCustomer(text)).toBe(true);
  });

  it.each([
    "Meet our new sourdough, baked fresh every morning",
    "Our studio has five rooms and a sauna",
    "Try your first class free this week",
    "Presenter video for our 5 star resort",
    "Steam over our 5 star breakfast",
    "I tried dozens of flours before I found this one",
    "I switched to organic beans last year",
  ])("leaves the presenter's own pitch alone: %s", (text) => {
    expect(isTestimonialIntent(text)).toBe(false);
    expect(speaksAsCustomer(text)).toBe(false);
  });

  it.each(["social", "cinematic"] as const)("refuses a %s render_video that asks for customer endorsements, and still allows an ordinary one", (intent) => {
    expect(shouldRefuseGeneratedEndorsement(intent, "customer testimonials over shots of the shop")).toBe(true);
    expect(shouldRefuseGeneratedEndorsement(intent, "diners raving about our pizza")).toBe(true);
    expect(shouldRefuseGeneratedEndorsement(intent, "happy people eating at our 5 star bakery")).toBe(false);
    expect(shouldRefuseGeneratedEndorsement(intent, "our customers love the new menu")).toBe(false);
  });

  it("keeps the presenter rule for talking_head and leaves animate to its own check", () => {
    expect(shouldRefuseGeneratedEndorsement("talking_head", "a happy customer explains the app")).toBe(true);
    expect(shouldRefuseGeneratedEndorsement("talking_head", "Presenter video for our 5 star resort")).toBe(false);
    expect(shouldRefuseGeneratedEndorsement("animate", "customer testimonials")).toBe(false);
  });

  it("refuses a Zavi chat presenter whose script speaks as a customer", () => {
    expect(shouldRefuseGeneratedEndorsement("talking_head", "UGC ad for UpcarAI I bought a rental on UpcarAI and saved a fortune")).toBe(true);
    expect(shouldRefuseGeneratedEndorsement("talking_head", "UGC ad I’ve been using UpcarAI for months")).toBe(true);
    expect(shouldRefuseGeneratedEndorsement("talking_head", "UGC ad for UpcarAI Book a car in two taps and drive away today")).toBe(false);
  });
});

describe("customer words that are not a customer speaking", () => {
  const refusedAnywhere = (text: string) =>
    speaksAsCustomer(text) ||
    asksPresenterToSpeakAsCustomer(text) ||
    (["talking_head", "social", "cinematic"] as const).some((intent) => shouldRefuseGeneratedEndorsement(intent, text));

  it.each([
    "Presenter video: we started as a customer-first bakery on Main Street",
    "Have the presenter act as a customer service rep explaining our returns",
    "Our customer success team answers in an hour",
    "Presenter speaks as one of our customer success team: we answer in an hour",
    "As a customer care lead I answer every email myself",
    "I bought this oven years ago and started baking",
    "Presenter says: I'm one of our customer support leads and here is how refunds work",
  ])("lets %j through", (text) => {
    expect(refusedAnywhere(text)).toBe(false);
  });

  it.each([
    "I've been ordering Cakely cakes for months as a regular customer",
    "presenter tells viewers they have been ordering Cakely for months as a regular customer",
    "pretend to be a happy customer",
    "act as a loyal client who loves it",
    "I bought it and it changed my life",
    "I bought it and I love it",
    "I ordered them twice and they are the best",
    "I bought a Cakely cake for my mum's birthday",
    "I have bought five cakes from you",
    "I bought one as a regular customer",
    "presenter should say they bought a Cakely cake for her mum's birthday",
  ])("still refuses %j", (text) => {
    expect(refusedAnywhere(text)).toBe(true);
  });
});

describe("scene endorsement check on social, cinematic and animate videos", () => {
  it.each([
    "cinematic pan as guests review the menu at our bistro",
    "social clip: users reviewing their analytics dashboard",
    "keep the caption, no on-screen reviews",
    "a 5 stars hotel at dusk",
    "remove the testimonials overlay",
    "a social video of happy customers enjoying lattes at our cafe",
  ])("does not refuse %s", (text) => {
    expect(asksForCustomerEndorsement(text)).toBe(false);
    expect(showsCustomerEndorsement(text)).toBe(false);
  });

  it.each([
    "\u2b50\ufe0f\u2b50\ufe0f\u2b50\ufe0f\u2b50\ufe0f\u2b50\ufe0f overlay over our cakes",
    "diners raving about our pizza",
    "on-screen text with our Google reviews",
    "customers giving us a five star rating",
  ])("refuses %s", (text) => {
    expect(asksForCustomerEndorsement(text)).toBe(true);
  });
});

describe("a customer quoted on screen in the model's scene", () => {
  it("refuses a made-up customer turning to camera with a line", () => {
    expect(showsCustomerEndorsement("A customer turns to the camera and says: 'Best coffee in town!'")).toBe(true);
    expect(showsCustomerEndorsement("A diner tells the camera this is the best pizza she has had")).toBe(true);
  });

  it("allows a barista talking to a customer in the scene", () => {
    expect(showsCustomerEndorsement("A barista hands a customer a latte and smiles")).toBe(false);
  });
});
