import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// Desktop dev uses plain http://localhost (already a secure context).
// `npm run dev:quest` serves https over LAN — WebXR, WebGPU and
// AudioWorklet require a secure context, and the Quest browser reaches
// the dev server by LAN IP (accept the self-signed cert warning once).
export default defineConfig(({ mode }) => ({
  // relative base: the build works from any subpath (e.g. GitHub Pages)
  base: './',
  plugins: mode === 'quest' ? [basicSsl()] : [],
  server: {
    host: true,
  },
}));
