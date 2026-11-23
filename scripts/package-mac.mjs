import { packager } from '@electron/packager';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('Build the Mac distribution on macOS.');
const root = fileURLToPath(new URL('../', import.meta.url));
const build = path.join(root, 'build', 'mac');
const stage = path.join(build, 'app');
const out = path.join(root, 'dist');
const metadata = JSON.parse(readFileSync(path.join(root, 'package.json')));
const arch = process.env.DAYLINE_ARCH || 'universal';
if (!['universal', 'arm64', 'x64'].includes(arch)) throw new Error('Choose universal, arm64, or x64.');
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });
rmSync(build, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
mkdirSync(out, { recursive: true });
for (const item of ['src', 'web', 'desktop/main.cjs', 'node_modules/luxon']) {
  const dest = path.join(stage, item);
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(path.join(root, item), dest, { recursive: true });
}
writeFileSync(path.join(stage, 'package.json'), JSON.stringify({
  name: metadata.name, productName: metadata.productName, version: metadata.version,
  author: metadata.author, description: metadata.description, type: 'module', main: metadata.main,
  dependencies: metadata.dependencies
}, null, 2));

// Render the same vector mark used in the planner into the Mac icon's native resolutions.
const artwork = readFileSync(path.join(root, 'web', 'mark.svg'), 'utf8').replace('<svg ', '<svg width="1024" height="1024" ');
const svg = path.join(build, 'icon.svg');
const master = path.join(build, 'icon.png');
const iconset = path.join(build, 'Dayline.iconset');
writeFileSync(svg, artwork);
mkdirSync(iconset);
run('sips', ['-s', 'format', 'png', svg, '--out', master]);
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    const pixels = String(size * scale);
    const name = 'icon_' + size + 'x' + size + (scale === 2 ? '@2x' : '') + '.png';
    run('sips', ['-z', pixels, pixels, master, '--out', path.join(iconset, name)]);
  }
}
const icon = path.join(build, 'Dayline.icns');
run('iconutil', ['-c', 'icns', '-o', icon, iconset]);

const extras = [];
const sdk = execFileSync('xcrun', ['--show-sdk-path'], { encoding: 'utf8' }).trim();
if (existsSync(path.join(sdk, 'System/Library/Frameworks/FoundationModels.framework'))) {
  const architectures = arch === 'universal' ? ['arm64', 'x86_64'] : [arch === 'x64' ? 'x86_64' : arch];
  const slices = architectures.map(cpu => {
    const slice = path.join(build, 'estimator-' + cpu);
    run('xcrun', ['swiftc', '-O', '-parse-as-library', '-target', cpu + '-apple-macos13.0', path.join(root, 'desktop/Estimator.swift'), '-o', slice]);
    return slice;
  });
  const estimator = path.join(build, 'estimator');
  run('lipo', ['-create', ...slices, '-output', estimator]);
  extras.push(estimator);
}
if (process.env.DAYLINE_GOOGLE_CLIENT_FILE) {
  const config = JSON.parse(readFileSync(process.env.DAYLINE_GOOGLE_CLIENT_FILE, 'utf8'));
  if (!config.installed?.client_id) throw new Error('Use an installed-application Google OAuth client JSON file.');
  const client = path.join(build, 'google-client.json');
  writeFileSync(client, JSON.stringify({ installed: { client_id: config.installed.client_id, client_secret: config.installed.client_secret || '' } }), { mode: 0o600 });
  extras.push(client);
}
// A build for someone who hosts their own receiver carries its address, so the app needs no environment variable.
if (process.env.DAYLINE_PUSH_RELAY !== undefined || process.env.DAYLINE_RELAY_ACCOUNT !== undefined) {
  const { checkedReceiverFile } = await import('../src/receiver-choice.mjs');
  const receiver = path.join(build, 'receiver.json');
  const carried = checkedReceiverFile({ origin: process.env.DAYLINE_PUSH_RELAY, account: process.env.DAYLINE_RELAY_ACCOUNT });
  // Only what was named is carried; the rest keeps its default in the app.
  writeFileSync(receiver, JSON.stringify({ ...(process.env.DAYLINE_PUSH_RELAY !== undefined && { origin: carried.origin }),
    ...(process.env.DAYLINE_RELAY_ACCOUNT !== undefined && { account: carried.account }) }));
  extras.push(receiver);
}
const [directory] = await packager({
  dir: stage, out, name: 'Dayline', arch, platform: 'darwin', icon, electronVersion: metadata.devDependencies.electron,
  appBundleId: 'space.antaia.dayline', appCategoryType: 'public.app-category.productivity',
  asar: true, prune: false, overwrite: true, extraResource: extras,
  protocols: [{ name: 'Dayline task', schemes: ['dayline'] }],
  extendInfo: { LSMinimumSystemVersion: '13.0' }
});
const bundle = path.join(directory, 'Dayline.app');
run('codesign', ['--force', '--deep', '--sign', '-', bundle]);
run('codesign', ['--verify', '--deep', '--strict', bundle]);
const zip = path.join(out, 'Dayline-' + metadata.version + '-mac-' + arch + '.zip');
run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', bundle, zip]);
console.log(zip);
