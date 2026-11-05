import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../src/paths.mjs';
import { registry } from './pack-internal.mjs';
import { normalizePackageModes } from './package-modes.mjs';
const source = join(ROOT, 'packages/relay'),
  temp = await mkdtemp(join(tmpdir(), 'agent-network-relay-'));
try {
  const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  delete pkg.private;
  delete pkg.scripts;
  pkg.repository = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')).repository;
  Object.assign(pkg, {
    files: ['cli.mjs', 'shared.mjs', 'README.md', 'CHANGELOG.md', 'npm-shrinkwrap.json'],
    bundleDependencies: Object.keys(pkg.dependencies),
    publishConfig: { registry, access: 'restricted' }
  });
  await writeFile(join(temp, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  for (const n of ['cli.mjs', 'README.md', 'CHANGELOG.md']) await copyFile(join(source, n), join(temp, n));
  await copyFile(join(ROOT, 'src/federation-identity.mjs'), join(temp, 'shared.mjs'));
  await copyFile(join(source, 'package-lock.json'), join(temp, 'npm-shrinkwrap.json'));
  for (const file of pkg.files) await chmod(join(temp, file), file === 'cli.mjs' ? 0o755 : 0o644);
  await chmod(join(temp, 'package.json'), 0o644);
  execFileSync(
    'npm',
    ['ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--prefer-offline'],
    { cwd: temp, stdio: 'pipe', timeout: 180000 }
  );
  await normalizePackageModes(temp);
  const [packed] = JSON.parse(
    execFileSync('npm', ['pack', '--json', '--ignore-scripts'], { cwd: temp, encoding: 'utf8' })
  );
  const file = join(ROOT, 'dist', packed.filename);
  await mkdir(join(ROOT, 'dist'), { recursive: true });
  const data = await readFile(join(temp, packed.filename));
  const old = await readFile(file).catch((e) => {
    if (e.code !== 'ENOENT') throw e;
  });
  if (old && !data.equals(old))
    throw new Error('Relay artifact already exists with different bytes; change the version');
  if (!old) await writeFile(file, data, { flag: 'wx' });
  console.log(JSON.stringify({ package: packed.id, integrity: packed.integrity, file }));
} finally {
  await rm(temp, { recursive: true, force: true });
}
