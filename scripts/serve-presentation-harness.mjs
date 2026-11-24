import { createServer } from 'node:http';
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const { outputFiles } = await build({ entryPoints: ['test/presentation-harness.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2023' });
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>UBVE presentation verification</title>
<style>body{font:16px system-ui;background:#10141e;color:#e9edf5;margin:32px}button{font:inherit;padding:12px 24px;border-radius:12px;cursor:pointer}#stage{position:relative;width:640px;height:360px;max-width:100%;background:#000;border:1px solid #485067;margin:24px 0}video{width:100%;height:100%}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px monospace}h1{font-size:28px}</style>
<h1>UBVE presentation verification</h1><p>Real muted AudioWorklet, ASS worker and IMSC rendering. GPU/native decode and physical output are not tested.</p>
<button id="run">Run presentation checks</button><div id="stage"><video playsinline muted></video><div id="overlay"></div></div><pre id="result">Ready</pre><script type="module" src="/harness.js"></script></html>`;
const server = createServer(async (request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp'); response.setHeader('Cache-Control', 'no-store');
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  if (pathname === '/' && request.method === 'GET') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html); return; }
  if (pathname === '/harness.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(outputFiles[0].contents); return; }
  if (pathname === '/__evidence' && request.method === 'POST') {
    try {
      let body = ''; for await (const part of request) { body += part; if (body.length > 1_000_000) throw new Error('Evidence body limit'); }
      const evidence = JSON.parse(body);
      if (evidence.schema !== 'ubve-presentation-browser-v2') throw new Error('Unexpected evidence schema');
      await mkdir('evidence', { recursive: true });
      const destination = `evidence/presentation-browser-${Date.now()}.json`;
      await writeFile(destination, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
      console.log(`Saved ${destination}: ${evidence.status}`); response.end('saved');
    } catch (error) { response.writeHead(400); response.end(String(error)); }
    return;
  }
  const target = path.resolve(root, 'apps/vue-player/public', '.' + decodeURIComponent(pathname));
  if (!target.startsWith(path.join(root, 'apps/vue-player/public') + path.sep)) { response.writeHead(403); response.end(); return; }
  try {
    const bytes = await readFile(target); response.setHeader('Content-Type', target.endsWith('.wasm') ? 'application/wasm' : target.endsWith('.js') ? 'text/javascript' : 'application/octet-stream'); response.end(bytes);
  } catch { response.writeHead(404); response.end(); }
});
server.listen(Number(process.env.UBVE_PRESENTATION_PORT ?? 8174), '0.0.0.0', () => console.log(`Presentation harness http://127.0.0.1:${server.address().port}`));
