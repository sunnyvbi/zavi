export const pastWorkKeyframes = {
  "past-work-file-drop": {
    "0%": { opacity: "0", transform: "translate(-24px, -84px) scale(.96)" },
    "18%": { opacity: "1" },
    "78%, 100%": { opacity: "1", transform: "translate(0, 0) scale(1)" },
  },
  "past-work-enter": {
    from: { opacity: "0", transform: "translateY(10px)" },
    to: { opacity: "1", transform: "translateY(0)" },
  },
  "past-work-demo": {
    from: { opacity: "0", transform: "translateY(24px) scale(.97)" },
    to: { opacity: "1", transform: "translateY(0) scale(1)" },
  },
  "past-work-point": {
    from: { opacity: "0", transform: "translate(28px, 22px)" },
    to: { opacity: "1", transform: "translate(0, 0)" },
  },
  "past-work-tip": {
    from: { opacity: "0", transform: "translate(-50%, 4px)" },
    to: { opacity: "1", transform: "translate(-50%, 0)" },
  },
  "strategy-write": {
    from: { clipPath: "inset(0 100% 0 0)" },
    to: { clipPath: "inset(0 0 0 0)" },
  },
  "strategy-shine": {
    from: { backgroundPosition: "200% 0" },
    to: { backgroundPosition: "-200% 0" },
  },
};
export const pastWorkAnimation = {
  "past-work-file-drop": "past-work-file-drop 1100ms cubic-bezier(.22,1,.36,1) both",
  "past-work-enter": "past-work-enter 320ms cubic-bezier(.34,1.56,.64,1) both",
  "past-work-demo": "past-work-demo 420ms cubic-bezier(.34,1.56,.64,1) both",
  "past-work-point": "past-work-point 300ms ease-out both",
  "past-work-tip": "past-work-tip 180ms ease-out both",
  "strategy-write": "strategy-write 600ms cubic-bezier(.2,0,0,1) both",
  "strategy-shine": "strategy-shine 2.4s linear infinite",
};

export const websiteKeyframes = {
  "website-rival-three": {
    "0%, 20%, 100%": { transform: "translateX(-8px)" },
    "26%, 92%": { transform: "translateX(0)" },
  },
  "website-rival-two": {
    "0%, 19%, 100%": { transform: "translateX(-8px)" },
    "25%, 92%": { transform: "translateX(0)" },
  },
  "website-rival-one": {
    "0%, 18%, 100%": { transform: "translateX(-8px)" },
    "24%, 92%": { transform: "translateX(0)" },
  },
  "website-bar-four": {
    "0%, 42%, 100%": { transform: "scaleY(0.2)" },
    "48%, 92%": { transform: "scaleY(1)" },
  },
  "website-bar-three": {
    "0%, 41%, 100%": { transform: "scaleY(0.2)" },
    "47%, 92%": { transform: "scaleY(1)" },
  },
  "website-bar-two": {
    "0%, 40%, 100%": { transform: "scaleY(0.2)" },
    "46%, 92%": { transform: "scaleY(1)" },
  },
  "website-bar-one": {
    "0%, 39%, 100%": { transform: "scaleY(0.2)" },
    "45%, 92%": { transform: "scaleY(1)" },
  },
  "website-growth": {
    "0%, 38%, 100%": {
      opacity: "0.4",
      transform: "scale(0.98)",
      borderColor: "transparent",
      boxShadow: "none",
    },
    "43%, 92%": {
      opacity: "1",
      transform: "scale(1)",
      borderColor: "#ededed",
      boxShadow:
        "0 2px 3px rgb(11 11 11 / 0.06), 0 6px 12px rgb(11 11 11 / 0.04)",
    },
  },
  "website-constraint": {
    "0%, 28%, 100%": {
      opacity: "0.4",
      transform: "scale(0.98)",
      borderColor: "transparent",
      boxShadow: "none",
    },
    "33%, 92%": {
      opacity: "1",
      transform: "scale(1)",
      borderColor: "#ededed",
      boxShadow:
        "0 2px 3px rgb(11 11 11 / 0.06), 0 6px 12px rgb(11 11 11 / 0.04)",
    },
  },
  "website-competitors": {
    "0%, 18%, 100%": {
      opacity: "0.4",
      transform: "scale(0.98)",
      borderColor: "transparent",
      boxShadow: "none",
    },
    "23%, 92%": {
      opacity: "1",
      transform: "scale(1)",
      borderColor: "#ededed",
      boxShadow:
        "0 2px 3px rgb(11 11 11 / 0.06), 0 6px 12px rgb(11 11 11 / 0.04)",
    },
  },
  "website-business": {
    "0%, 8%, 100%": {
      opacity: "0.4",
      transform: "scale(0.98)",
      borderColor: "transparent",
      boxShadow: "none",
    },
    "13%, 92%": {
      opacity: "1",
      transform: "scale(1)",
      borderColor: "#ededed",
      boxShadow:
        "0 2px 3px rgb(11 11 11 / 0.06), 0 6px 12px rgb(11 11 11 / 0.04)",
    },
  },
  "website-enter": {
    from: { opacity: "0", transform: "translateY(8px)" },
    to: { opacity: "1", transform: "translateY(0)" },
  },
  "website-shine": {
    "0%": { opacity: "1", transform: "translateX(-100%)" },
    "12%": { opacity: "1", transform: "translateX(100%)" },
    "13%, 100%": { opacity: "0", transform: "translateX(100%)" },
  },
  "website-business-pill": {
    "0%, 8%, 100%": { width: "32px" },
    "14%, 92%": { width: "56px" },
  },
};
export const websiteAnimation = {
  "website-enter": "website-enter 240ms cubic-bezier(0.16,1,0.3,1) both",
  "website-shine": "website-shine 8s linear infinite",
  "website-business-pill": "website-business-pill 8s ease-in-out infinite",
  "website-business":
    "website-business 8s cubic-bezier(0.34,1.56,0.64,1) infinite",
  "website-competitors":
    "website-competitors 8s cubic-bezier(0.34,1.56,0.64,1) infinite",
  "website-constraint":
    "website-constraint 8s cubic-bezier(0.34,1.56,0.64,1) infinite",
  "website-growth": "website-growth 8s cubic-bezier(0.34,1.56,0.64,1) infinite",
  "website-bar-one":
    "website-bar-one 8s cubic-bezier(0.34,1.56,0.64,1) infinite",
  "website-bar-two":
    "website-bar-two 8s cubic-bezier(0.34,1.56,0.64,1) infinite",
  "website-bar-three":
    "website-bar-three 8s cubic-bezier(0.34,1.56,0.64,1) infinite",
  "website-bar-four":
    "website-bar-four 8s cubic-bezier(0.34,1.56,0.64,1) infinite",
  "website-rival-one":
    "website-rival-one 8s cubic-bezier(0.34,1.56,0.64,1) infinite",
  "website-rival-two":
    "website-rival-two 8s cubic-bezier(0.34,1.56,0.64,1) infinite",
  "website-rival-three":
    "website-rival-three 8s cubic-bezier(0.34,1.56,0.64,1) infinite",
};
