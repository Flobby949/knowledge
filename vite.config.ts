import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiPort = process.env.VITE_API_PORT ?? "3001";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": `http://127.0.0.1:${apiPort}`,
    },
  },
});
