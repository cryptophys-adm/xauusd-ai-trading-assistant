import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The Nexus Worker serves dist/ as Workers Static Assets (same build as the Cerebrum Console UI):
// external module scripts and stylesheets only, no inline script, no modulepreload polyfill.
export default defineConfig({
  plugins: [react()],
  base: "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 900,
    rollupOptions: { output: { manualChunks: { three: ["three"], charts: ["lightweight-charts"], react: ["react", "react-dom", "framer-motion"] } } },
  },
});
