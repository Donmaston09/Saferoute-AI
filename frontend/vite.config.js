import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,           // Expose on LAN for phone testing
    port: 5173,
  },
  build: {
    target:    "es2020",
    outDir:    "dist",
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          "tf":      ["@tensorflow/tfjs"],
          "cocossd": ["@tensorflow-models/coco-ssd"],
        },
      },
    },
  },
  define: {
    "process.env": {},    // TF.js compatibility
  },
});
