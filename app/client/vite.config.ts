import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// Dev: `npm run dev` proxies /api to the FastAPI engine on :8770. Build: static files in dist/, served by app.py.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  server: { port: 5173, proxy: { "/api": "http://localhost:8770" } },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 4000 },
});
