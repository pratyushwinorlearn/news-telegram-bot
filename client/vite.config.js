import { defineConfig } from "vite";

export default defineConfig({
  server: {
    proxy: {
      // In dev, the frontend calls /api/news and Vite forwards it to the
      // Express server on port 3001. The browser never sees the backend's
      // real URL or anything about the API key — that's entirely server-side.
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true
      }
    }
  }
});
