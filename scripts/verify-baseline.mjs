import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build, projectRoot } from './build.mjs';

const baseline = JSON.parse(await readFile(new URL('../tests/baseline/v18.sha256.json', import.meta.url), 'utf8'));
await build();
for (const entry of baseline.files) {
  for (const filename of [entry.source, 'dist/' + entry.dist]) {
    const bytes = await readFile(resolve(projectRoot, filename));
    assert.equal(bytes.length, entry.bytes, `${filename}: changed size since original ${baseline.version}`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, `${filename}: changed since original ${baseline.version}`);
  }
}
console.log(`Verified ${baseline.files.length} source and built files are byte-identical to the original ${baseline.version}.`);
console.log('This is a frozen migration check, not a requirement for intentional future feature changes.');
