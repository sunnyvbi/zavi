import type { Config } from "tailwindcss";

const token = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        background: token("background"),
        foreground: token("foreground"),
        card: { DEFAULT: token("card"), foreground: token("card-foreground") },
        muted: { DEFAULT: token("muted"), foreground: token("muted-foreground") },
        primary: { DEFAULT: token("primary"), foreground: token("primary-foreground") },
        secondary: { DEFAULT: token("secondary"), foreground: token("secondary-foreground") },
        accent: { DEFAULT: token("accent"), foreground: token("accent-foreground") },
        danger: { DEFAULT: token("danger"), foreground: token("danger-foreground") },
        success: token("success"),
        inverse: { DEFAULT: token("inverse"), foreground: token("inverse-foreground") },
        border: token("border"),
        input: token("input"),
        ring: token("ring"),
      },
      fontFamily: {
        display: ["var(--font-display)"],
        body: ["var(--font-body)"],
        sans: ["var(--font-body)"],
      },
      fontSize: {
        "display-xl": ["clamp(2.5rem, 6vw + 1rem, 4.75rem)", { lineHeight: "1.02" }],
        "display-lg": ["clamp(2.125rem, 4vw + 1rem, 3.5rem)", { lineHeight: "1.08" }],
        "display-md": ["clamp(1.75rem, 2.5vw + 1rem, 2.5rem)", { lineHeight: "1.15" }],
      },
      spacing: {
        section: "clamp(4rem, 8vw, 7rem)",
      },
      borderRadius: {
        DEFAULT: "var(--radius)",
        sm: "max(0px, calc(var(--radius) - 4px))",
        md: "max(0px, calc(var(--radius) - 2px))",
        lg: "var(--radius)",
        xl: "calc(var(--radius) * 1.5)",
        "2xl": "calc(var(--radius) * 2)",
      },
      boxShadow: {
        sm: "var(--shadow-sm)",
        DEFAULT: "var(--shadow-md)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
      },
      keyframes: {
        "fade-up": { from: { opacity: "0", transform: "translateY(16px)" }, to: { opacity: "1", transform: "none" } },
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
      },
      animation: {
        "fade-up": "fade-up 0.7s cubic-bezier(0.22, 1, 0.36, 1) both",
        "fade-in": "fade-in 0.6s ease-out both",
      },
    },
  },
  plugins: [],
} satisfies Config;
