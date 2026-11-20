import localFont from "next/font/local";

export const onboardingDisplay = localFont({
  src: [
    { path: "./InterDisplay-Regular.ttf", weight: "400", style: "normal" },
    { path: "./InterDisplay-SemiBold.ttf", weight: "600", style: "normal" },
  ],
  variable: "--font-onboarding",
  display: "swap",
});
