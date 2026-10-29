// Builds dist/diffscout-<version>.zip with only the files the extension needs, for the Chrome Web Store.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(fs.readFileSync(`${root}manifest.json`, 'utf8'));
const zip = `dist/diffscout-${version}.zip`;
fs.mkdirSync(`${root}dist`, { recursive: true });
fs.rmSync(`${root}${zip}`, { force: true });
execFileSync('zip', ['-r', '-X', zip, 'manifest.json', 'options.html', 'options.js', 'src', 'icons', 'LICENSE'], { cwd: root, stdio: 'inherit' });
console.log(`Wrote ${zip}`);
