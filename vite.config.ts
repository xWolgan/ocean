import { defineConfig, type Plugin, type ViteDevServer } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

// Reference-room persistence (dev server ONLY — `apply: 'serve'`).
// room.html is deliberately NOT a build entry and refroom/ lives outside
// public/, so neither ever reaches dist/ or GitHub Pages: the room is a
// working space shared through git, not part of the published artwork.
// The endpoint can only write inside refroom/ (filename scrub below);
// it is reachable on the LAN like the rest of the dev server.
function roomDevApi(): Plugin {
  return {
    name: 'room-dev-api',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      const roomDir = path.join(root, 'refroom');
      server.middlewares.use('/__room', (req, res) => {
        // connect strips the mount prefix: req.url is '/ping', '/upload?…'
        const url = new URL(req.url ?? '/', 'http://x');
        const json = (code: number, body: unknown) => {
          res.statusCode = code;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(body));
        };
        if (req.method === 'GET' && url.pathname === '/ping') return json(200, { ok: true });
        if (req.method !== 'POST') return json(405, { error: 'method' });
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (c: Buffer) => {
          size += c.length;
          if (size > 60_000_000) {
            json(413, { error: 'too large' });
            req.destroy();
          } else chunks.push(c);
        });
        req.on('end', () => {
          try {
            const body = Buffer.concat(chunks);
            if (url.pathname === '/upload') {
              const raw = url.searchParams.get('name') ?? 'file';
              const safe =
                raw.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[.-]+/, '') || 'file';
              fs.mkdirSync(path.join(roomDir, 'assets'), { recursive: true });
              const dot = safe.lastIndexOf('.');
              const stem = dot > 0 ? safe.slice(0, dot) : safe;
              const ext = dot > 0 ? safe.slice(dot) : '';
              let file = safe;
              for (let i = 1; fs.existsSync(path.join(roomDir, 'assets', file)); i++)
                file = `${stem}-${i}${ext}`;
              fs.writeFileSync(path.join(roomDir, 'assets', file), body);
              json(200, { url: `refroom/assets/${file}` });
            } else if (url.pathname === '/save') {
              const data = JSON.parse(body.toString('utf8')); // must parse
              fs.mkdirSync(roomDir, { recursive: true });
              fs.writeFileSync(
                path.join(roomDir, 'room.json'),
                JSON.stringify(data, null, 2) + '\n',
              );
              json(200, { ok: true });
            } else json(404, { error: 'unknown' });
          } catch (e) {
            json(400, { error: String(e) });
          }
        });
      });
    },
  };
}

// Desktop dev uses plain http://localhost (already a secure context).
// `npm run dev:quest` serves https over LAN — WebXR, WebGPU and
// AudioWorklet require a secure context, and the Quest browser reaches
// the dev server by LAN IP (accept the self-signed cert warning once).
export default defineConfig(({ mode }) => ({
  // relative base: the build works from any subpath (e.g. GitHub Pages)
  base: './',
  plugins: [...(mode === 'quest' ? [basicSsl()] : []), roomDevApi()],
  server: {
    host: true,
  },
}));
