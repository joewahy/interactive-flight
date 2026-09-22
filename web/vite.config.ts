import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // Explicit rather than relying on the (currently also false) default,
    // so a future config change can't silently start shipping maps to prod.
    sourcemap: false,
  },
})
