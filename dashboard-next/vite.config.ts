import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Served by the Fastify API under /app. Build output goes straight into the
// project's public/ dir so the server can serve it as static files.
export default defineConfig({
  base: "/app/",
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  build: {
    outDir: path.resolve(__dirname, "../public/dashboard-next"),
    emptyOutDir: true,
  },
  server: {
    // dev proxy so `npm run dev` talks to a running API without CORS pain
    proxy: {
      "/admin": "http://127.0.0.1:3030",
      "/send": "http://127.0.0.1:3030",
      "/ready": "http://127.0.0.1:3030",
      "/health": "http://127.0.0.1:3030",
      "/conversations": "http://127.0.0.1:3030",
      "/messages": "http://127.0.0.1:3030",
      "/events": "http://127.0.0.1:3030",
      "/dashboard": "http://127.0.0.1:3030",
    },
  },
});
