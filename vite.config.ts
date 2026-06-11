import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// Multi-page build: the existing board (index.html) AND the Farcaster Mini App shell
// (miniapp.html). Both pages share the SAME client/engine modules under src/ — the Mini App
// is a host around the same board, not a second renderer. `public/.well-known/farcaster.json`
// is copied to the deploy root by Vite's publicDir handling.
export default defineConfig({
  base: "./", // relative asset paths — works at a domain root AND under a sub-path (GitHub Pages)
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        miniapp: fileURLToPath(new URL("./miniapp.html", import.meta.url)),
      },
    },
  },
});
