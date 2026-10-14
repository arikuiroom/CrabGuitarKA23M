import { createServer } from 'node:http';
import { watch } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, projectRoot } from './build.mjs';

const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
};
const inside = (path, root) => path === root || path.startsWith(root + sep);

// Only built app files and browser fixtures are exposed, never repository metadata.
export function createStaticServer({ dist = resolve(projectRoot, 'dist'), fixtures = resolve(projectRoot, 'tests/browser') } = {}) {
  return createServer(async (request, response) => {
    try {
      if (!['GET', 'HEAD'].includes(request.method)) {
        response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return;
      }
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').some(part => part.startsWith('.'))) {
        response.writeHead(403); response.end('Forbidden'); return;
      }
      const fixtureRequest = pathname === '/tests/browser' || pathname.startsWith('/tests/browser/');
      const root = resolve(fixtureRequest ? fixtures : dist);
      const relative = fixtureRequest ? pathname.slice('/tests/browser'.length) : pathname.replace(/^\/dist(?=\/|$)/, '');
      let filename = resolve(root, '.' + relative);
      if (!inside(filename, root)) { response.writeHead(403); response.end('Forbidden'); return; }
      let info = await stat(filename);
      if (info.isDirectory()) {
        if (!pathname.endsWith('/')) { response.writeHead(301, { Location: pathname + '/' }); response.end(); return; }
        filename = resolve(filename, 'index.html');
        info = await stat(filename);
      }
      if (!info.isFile() || !inside(await realpath(filename), await realpath(root))) {
        response.writeHead(403); response.end('Forbidden'); return;
      }
      const body = request.method === 'HEAD' ? undefined : await readFile(filename);
      response.writeHead(200, {
        'Content-Type': mimeTypes[extname(filename)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(body);
    } catch (error) {
      response.writeHead(error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 404 : error instanceof URIError ? 400 : 500);
      response.end('Request could not be served.');
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    if (index < 0) return fallback;
    if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} requires a value.`);
    return args[index + 1];
  };
  const port = Number(option('--port', process.env.PORT || '8080'));
  const host = option('--host', '127.0.0.1');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be an integer from 1 to 65535.');
  const live = args.includes('--watch');
  if (live) await build();
  else await stat(resolve(projectRoot, 'dist/index.html')).catch(() => { throw new Error('Run npm run build before npm run preview.'); });

  const server = createStaticServer();
  server.on('error', error => { console.error(error.message); process.exit(1); });
  server.listen(port, host, () => {
    console.log(`Instrument: http://${host}:${port}/`);
    console.log(`Browser checks: http://${host}:${port}/tests/browser/`);
    if (live) console.log('Watching src/ and public/. Refresh the browser after changes.');
  });
  let timer, building = false, rebuildAgain = false;
  const rebuild = async () => {
    if (building) { rebuildAgain = true; return; }
    building = true;
    do {
      rebuildAgain = false;
      try { await build(); console.log('Rebuilt dist/. Refresh to see changes.'); }
      catch (error) { console.error('Build failed:', error.message); }
    } while (rebuildAgain);
    building = false;
  };
  const watchers = live ? ['src', 'public'].map(directory => watch(resolve(projectRoot, directory), { recursive: true }, () => {
    clearTimeout(timer); timer = setTimeout(rebuild, 80);
  })) : [];
  const close = () => { clearTimeout(timer); watchers.forEach(watcher => watcher.close()); server.close(); };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
}
