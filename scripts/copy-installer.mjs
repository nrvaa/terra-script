// The landing page's "Download for Windows" button serves public/downloads/TerraScript-Setup.exe.
//   node scripts/copy-installer.mjs         copy the freshly built NSIS installer there (after `tauri build`)
//   node scripts/copy-installer.mjs --strip  remove it from dist/, so the desktop app doesn't bundle its own installer
import fs from 'node:fs';
import path from 'node:path';

const OUT = 'public/downloads/TerraScript-Setup.exe';

if (process.argv.includes('--strip')) {
  fs.rmSync('dist/downloads', { recursive: true, force: true });
  process.exit(0);
}

const dir = 'src-tauri/target/release/bundle/nsis';
const { version } = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const file = fs.readdirSync(dir).find((f) => f.endsWith('-setup.exe') && f.includes(`_${version}_`));
if (!file) throw new Error(`No installer for version ${version} in ${dir}`);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.copyFileSync(path.join(dir, file), OUT);
console.log(`Copied ${file} -> ${OUT} (${(fs.statSync(OUT).size / 1048576).toFixed(1)} MB)`);
