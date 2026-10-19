import { readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
if (Number(process.versions.node.split('.')[0]) < 22) {
  throw new Error('Node.js 22 or later is required.');
}

async function sources(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const result = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await sources(path));
    else if (entry.isFile() && /\.(?:mjs|cjs|js)$/.test(entry.name)) result.push(path);
  }
  return result;
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
if (packageJson.type !== 'module') throw new Error('The package must use ESM.');
if (Object.keys(packageJson.dependencies ?? {}).length) {
  throw new Error('This proxy must have zero runtime dependencies.');
}
const files = (await Promise.all(['bin', 'src', 'scripts', 'test', 'tests'].map((name) => sources(join(root, name))))).flat();
for (const file of files) run(process.execPath, ['--check', file]);
if (process.platform === 'linux') {
  run('bash', ['-n', resolve(root, 'scripts/install.sh')]);
  run('bash', ['-n', resolve(root, 'scripts/test-install.sh')]);
  run('bash', ['-n', resolve(root, 'scripts/test-service.sh')]);
} else if (process.platform === 'win32') {
  const path = resolve(root, 'scripts/start.ps1').replaceAll("'", "''");
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$parseErrors = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${path}', [ref]$null, [ref]$parseErrors); if ($parseErrors.Count) { $parseErrors | ForEach-Object { Write-Error $_ }; exit 1 }`]);
}
console.log(`Checked ${files.length} JavaScript files and ${process.platform === 'linux' ? 'Linux shell' : process.platform === 'win32' ? 'PowerShell' : 'available'} syntax.`);
