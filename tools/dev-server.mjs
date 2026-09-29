/**
 * Local development server (GitHub Pages serves the same files in production).
 *
 *   npm run dev            → http://localhost:5173, talks to your real Supabase project
 *   npm run dev -- --fake  → no Supabase needed: swaps js/supabase.js for
 *                            tools/fake-supabase.js, which runs supabase/schema.sql in an
 *                            in-browser Postgres (PGlite). Data lives in your browser only.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FAKE = process.argv.includes('--fake');
const PORT = Number(process.env.PORT) || 5173;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.sql': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
};

createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path.endsWith('/')) path += 'index.html';
  if (FAKE && path === '/js/supabase.js') path = '/tools/fake-supabase.js';

  const file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT.replace(/[\\/]$/, '') + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}).listen(PORT, () => {
  console.log(`Solar Gators Orders dev server: http://localhost:${PORT}${FAKE ? '  (FAKE backend — local data only)' : ''}`);
});
