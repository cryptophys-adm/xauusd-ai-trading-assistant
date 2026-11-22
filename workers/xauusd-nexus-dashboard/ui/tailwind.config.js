/**
 * Obsidian surfaces and motion: the same as the Cerebrum Console (cryptophys-cloud-platform workers/console/ui).
 * The Nexus colour set (direction, status, text) is the @theme block in src/index.css with src/lib/tokens.ts.
 */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        obsidian: { DEFAULT: "#05070c", deep: "#080b11", panel: "#0b0f18", bar: "#0f1522", foot: "#081019" },
      },
      fontFamily: { mono: ["JetBrains Mono", "ui-monospace", "SF Mono", "Fira Code", "monospace"] },
      keyframes: {
        "pulse-dot": { "0%,100%": { transform: "scale(1)", opacity: "0.9" }, "50%": { transform: "scale(2.2)", opacity: "0" } },
        "slide-up": { "0%": { opacity: "0", transform: "translateY(6px)" }, "100%": { opacity: "1", transform: "translateY(0)" } },
        "ping-slow": { "0%,100%": { transform: "scale(1)", opacity: "1" }, "50%": { transform: "scale(1.6)", opacity: "0" } },
      },
      animation: {
        "pulse-dot": "pulse-dot 2.2s ease-in-out infinite",
        "slide-up": "slide-up 0.28s ease-out forwards",
        "ping-slow": "ping-slow 2.4s cubic-bezier(0,0,0.2,1) infinite",
      },
    },
  },
  plugins: [],
};
