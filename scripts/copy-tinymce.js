#!/usr/bin/env node
// Kopiert TinyMCE aus node_modules nach public/vendor/tinymce, damit der
// Editor vom eigenen Server kommt (kein CDN, kein Fremdanbieter). Im Projekt
// als postinstall eintragen: "postinstall": "astro-mini-cms-tinymce".
// Der Zielordner gehoert in .gitignore.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(join(process.cwd(), 'package.json'));
let src;
try {
  src = dirname(require.resolve('tinymce/package.json'));
} catch {
  console.error('tinymce ist nicht installiert (npm install tinymce)');
  process.exit(1);
}
const dst = join(process.cwd(), 'public', 'vendor', 'tinymce');
if (!existsSync(src)) {
  console.error('tinymce nicht gefunden unter ' + src);
  process.exit(1);
}
rmSync(dst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });
for (const part of ['tinymce.min.js', 'themes', 'models', 'icons', 'plugins', 'skins']) {
  cpSync(join(src, part), join(dst, part), { recursive: true });
}
console.log('tinymce → public/vendor/tinymce');
