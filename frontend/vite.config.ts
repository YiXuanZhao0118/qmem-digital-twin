import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8010",
      "/assets": "http://localhost:8010",
      "/ws": { target: "ws://localhost:8010", ws: true },
    },
  },
  // Dedupe react/react-dom so @monaco-editor/react (Phase B.5) doesn't
  // pick up its own copy via transitive deps — duplicate React instances
  // trigger "Invalid hook call" inside Monaco's wrapper component.
  resolve: {
    dedupe: ["react", "react-dom"],
  },
});

