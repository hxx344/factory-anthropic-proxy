import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, chmod } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = resolve(root, 'dist');
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
if (!Array.isArray(pkg.files) || !pkg.files.length) throw new Error('package.json must declare an explicit files allowlist.');
await mkdir(dist, { recursive: true });
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this script with npm run package.');
const result = spawnSync(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', dist], {
  cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
});
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(result.stderr || 'npm pack failed.');
const [packed] = JSON.parse(result.stdout);
const archive = resolve(dist, basename(packed.filename));
const allowedRoots = new Set(['bin', 'src', 'scripts', 'docs']);
const allowedFiles = new Set(['package.json', 'README.md', 'LICENSE', 'start.cmd', 'proxy.config.example.json', '.env.example']);
try {
  for (const entry of packed.files) {
    const path = entry.path.replaceAll('\\', '/');
    if (path.split('/').some((part) => part === '..' || part === '.git' || part === '.local' || part === 'node_modules'
      || part === 'proxy.config.json' || part === '.env' || (part.startsWith('.env.') && path !== '.env.example'))
      || (!allowedFiles.has(path) && !allowedRoots.has(path.split('/')[0]))) {
      throw new Error(`Refusing unexpected or private package entry: ${path}`);
    }
  }
  for (const required of ['bin/proxy.mjs', 'scripts/install.sh', 'scripts/check.mjs', 'scripts/start.ps1', 'start.cmd']) {
    if (!packed.files.some((entry) => entry.path === required)) throw new Error(`Missing required package entry: ${required}`);
  }
} catch (error) {
  await rm(archive, { force: true });
  throw error;
}
await copyFile(resolve(root, 'scripts/install.sh'), resolve(dist, 'install.sh'));
await chmod(resolve(dist, 'install.sh'), 0o755);
const checksums = [];
for (const name of [basename(archive), 'install.sh']) {
  const content = await readFile(resolve(dist, name));
  checksums.push(`${createHash('sha256').update(content).digest('hex')}  ${name}`);
}
const { writeFile } = await import('node:fs/promises');
await writeFile(resolve(dist, 'SHA256SUMS'), `${checksums.join('\n')}\n`);
console.log(`Packaged ${basename(archive)}, install.sh and SHA256SUMS in ${dist}`);
