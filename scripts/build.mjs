import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const sourceFiles = ['app.js', 'audio.js', 'free-mode.js', 'sprite-parts.js', 'style.css'];

export async function listFiles(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(resolve(directory, entry.name), relative + '/'));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`Unsupported non-file build input: ${relative}`);
  }
  return files.sort();
}

// No bundler, compiler, minifier or dependency install: output is an exact copy.
export async function build(output = resolve(projectRoot, 'dist')) {
  output = resolve(output);
  if (output === projectRoot || output === resolve(projectRoot, 'src') || output === resolve(projectRoot, 'public')) {
    throw new Error('Refusing to replace a source directory.');
  }
  const publicDirectory = resolve(projectRoot, 'public');
  const publicFiles = await listFiles(publicDirectory);
  for (const filename of sourceFiles) {
    if (publicFiles.includes(filename)) throw new Error(`Duplicate build input: public/${filename}`);
  }
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await cp(publicDirectory, output, { recursive: true });
  for (const filename of sourceFiles) await cp(resolve(projectRoot, 'src', filename), resolve(output, filename));
  return [...publicFiles, ...sourceFiles].sort();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = await build();
  console.log(`Built ${files.length} files in dist/ (byte-for-byte static copy).`);
}
