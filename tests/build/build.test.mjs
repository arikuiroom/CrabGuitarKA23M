import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { build, listFiles, projectRoot, sourceFiles } from '../../scripts/build.mjs';
import { createStaticServer } from '../../scripts/serve.mjs';

const exec = promisify(execFile);

test('static build preserves every source byte, excludes QA, and removes stale output', async () => {
  const output = await mkdtemp(resolve(tmpdir(), 'kani-build-'));
  try {
    await writeFile(resolve(output, 'stale.html'), 'obsolete build output');
    const expected = [...await listFiles(resolve(projectRoot, 'public')), ...sourceFiles].sort();
    assert.deepEqual(await build(output), expected);
    assert.deepEqual(await listFiles(output), expected);
    for (const relative of expected) {
      const source = resolve(projectRoot, sourceFiles.includes(relative) ? 'src' : 'public', relative);
      assert.deepEqual(await readFile(resolve(output, relative)), await readFile(source), `${relative} must remain byte-for-byte identical`);
    }
    assert(expected.includes('kani.png'), 'canonical artwork is packaged');
    for (const color of ['red', 'mint', 'black', 'darkbrown', 'redbrown']) assert(expected.includes(`sprites/${color}.png`));
    assert(!expected.some(path => /(^|\/)(qa-|test-|\.openai|\.git)/.test(path)), 'production output contains no QA or service metadata');
    const shell = await readFile(resolve(output, 'index.html'), 'utf8');
    for (const [, ref] of shell.matchAll(/(?:src|href)="([^"]+)"/g)) {
      if (ref.startsWith('#')) continue;
      assert(!/^(?:\/|https?:)/.test(ref), `portable relative URL: ${ref}`);
      const relative = ref === './' ? 'index.html' : ref.split('?')[0].replace(/^\.\//, '');
      assert(expected.includes(relative), `bundled shell resource: ${ref}`);
    }
    const manifest = JSON.parse(await readFile(resolve(output, 'manifest.webmanifest'), 'utf8'));
    assert.equal(manifest.start_url, './');
    assert.equal(manifest.scope, './');
    for (const icon of manifest.icons) assert(expected.includes(icon.src));
    for (const filename of sourceFiles.filter(file => file.endsWith('.js'))) {
      await exec(process.execPath, ['--check', resolve(projectRoot, 'src', filename)]);
    }
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('preview routes serve the app and current browser fixtures without exposing repository files', async () => {
  const output = await mkdtemp(resolve(tmpdir(), 'kani-server-'));
  let server;
  try {
    await build(output);
    server = createStaticServer({ dist: output });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const path of ['/', '/dist/index.html', '/app.js?v=18', '/audio.js?v=18', '/style.css?v=18', '/kani.png', '/sprites/mint.png', '/manifest.webmanifest', '/tests/browser/']) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      await response.arrayBuffer();
    }
    const fixtures = await listFiles(resolve(projectRoot, 'tests/browser'));
    for (const filename of fixtures.filter(file => !file.startsWith('generated/'))) {
      const fixtureUrl = base + '/tests/browser/' + filename;
      const response = await fetch(fixtureUrl);
      assert.equal(response.status, 200, filename);
      const html = await response.text();
      for (const [, relative] of html.matchAll(/(?:src="|import\(['"])(\.\.\/\.\.\/dist\/[^'"\)]+)/g)) {
        const dependency = await fetch(new URL(relative, fixtureUrl));
        assert.equal(dependency.status, 200, `${filename}: ${relative}`);
        await dependency.arrayBuffer();
      }
    }
    assert.equal((await fetch(base + '/.git/config')).status, 403);
    assert.equal((await fetch(base + '/src/audio.js')).status, 404);
    assert.equal((await fetch(base + '/package.json')).status, 404);
    assert.equal((await fetch(base + '/tests/audio/test-audio.mjs')).status, 404);
    assert.equal((await fetch(base + '/', { method: 'POST' })).status, 405);
    assert.equal((await fetch(base + '/%00')).status, 403);
    assert.equal((await fetch(base + '/%E0%A4%A')).status, 400);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(output, { recursive: true, force: true });
  }
});
