import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    // maplibre-gl's worker/GPU init didn't complete when served from Vite's
    // esbuild-prebundled copy; serving its own ESM build directly fixed it.
    exclude: ["maplibre-gl"],
  },
  build: {
    // Explicit rather than relying on the (currently also false) default,
    // so a future config change can't silently start shipping maps to prod.
    sourcemap: false,
  },
})
