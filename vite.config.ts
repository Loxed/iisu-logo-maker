import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// BASE_PATH lets the same build serve from a GitHub Pages sub path
// (BASE_PATH=/svg-extrude/ npm run build) and from a domain root on
// Cloudflare Pages, where the default "/" is correct.
export default defineConfig({
  base: process.env.BASE_PATH ?? "/",
  plugins: [react()],
  build: { target: "es2022", chunkSizeWarningLimit: 900 },
  worker: { format: "es" },
});
