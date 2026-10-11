import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: Vite serves the React app on :5173 and proxies /api → the Node backend
// on :4111, so the frontend can poll /api/status directly.
// Build: emits static assets to web/dist, which the Node server then hosts.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist" },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:4111",
        changeOrigin: true,
      },
    },
  },
});
