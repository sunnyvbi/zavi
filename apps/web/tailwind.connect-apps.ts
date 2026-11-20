export const connectAppsTheme = {
  spacing: { "onboarding-orbit": "320px", "onboarding-orbit-radius": "128px" },
  rotate: {
    "connect-north": "-90deg", "connect-north-east": "-60deg", "connect-east-north": "-30deg",
    "connect-east": "0deg", "connect-east-south": "30deg", "connect-south-east": "60deg",
    "connect-south": "90deg", "connect-south-west": "120deg", "connect-west-south": "150deg",
    "connect-west": "180deg", "connect-west-north": "210deg", "connect-north-west": "240deg",
  },
  maxWidth: { "onboarding-connect-card": "460px" },
  backgroundImage: { "connect-flow": "linear-gradient(to right, #d5d5d5 33%, transparent 0%)" },
  backgroundSize: { "connect-dash": "12px 1px" },
  keyframes: {
    "connect-orbit": { to: { transform: "rotate(360deg)" } },
    "connect-unorbit": { to: { transform: "rotate(-360deg)" } },
    "connect-flow": { to: { backgroundPosition: "-24px 0" } },
    "connect-pulse": { "0%, 100%": { transform: "scale(1)" }, "50%": { transform: "scale(1.06)" } },
  },
  animation: {
    "connect-orbit": "connect-orbit 60s linear infinite",
    "connect-unorbit": "connect-unorbit 60s linear infinite",
    "connect-flow": "connect-flow 1.2s linear infinite",
    "connect-pulse": "connect-pulse 3s cubic-bezier(.2,0,0,1) infinite",
  },
};
