// Regenerates the /redesign/ preview folder from the `redesign` branch.
// The branch is written root-absolute for a future real launch; the preview lives under
// /redesign/, so every absolute reference gets prefixed, canonicals become noindex, and the
// 1.2MB vendored js/ is shared from the site root instead of duplicated.
// Run from the repo root on master: node scripts/refresh-preview.mjs
import { execSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = process.cwd();
const OUT = join(REPO, 'redesign');

// what the preview carries; everything else (CNAME, README, scripts/, .github/, js/,
// resume.pdf, root jpgs, blog/open.html) stays behind
const TAKE = ['index.html', 'blog', 'puzzle', 'fonts-web', 'favicon.svg', 'og.png', 'og.html', '404.html'];
// these exist at the old site's root already — the preview reuses them instead of prefixing
const SHARED_ROOT = ['favicon.ico', 'infinite-jest.pdf'];

const tmp = mkdtempSync(join(tmpdir(), 'redesign-export-'));
const tar = join(tmp, 'export.tar');
execSync(`git archive redesign -o "${tar}"`, { cwd: REPO });
execSync(`tar -xf "${tar}" -C "${tmp}"`); // windows ships bsdtar
rmSync(tar, { force: true });

rmSync(OUT, { recursive: true, force: true });
for (const item of TAKE) cpSync(join(tmp, item), join(OUT, item), { recursive: true });
rmSync(join(OUT, 'blog', 'open.html'), { force: true }); // legacy redirect stub, root's concern

function* htmlFiles(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* htmlFiles(p);
    else if (name.endsWith('.html')) yield p;
  }
}

for (const file of htmlFiles(OUT)) {
  let s = readFileSync(file, 'utf8');
  s = s
    .replace(/(href="|src="|fetch\(')\//g, '$1/redesign/')
    .replace(/content="https:\/\/deskofjim\.com\//g, 'content="https://deskofjim.com/redesign/')
    .replace(/'\/blog\//g, "'/redesign/blog/")
    .replace(/src="js\//g, 'src="../js/');
  for (const shared of SHARED_ROOT) s = s.replaceAll(`/redesign/${shared}`, `/${shared}`);
  // a preview must not be indexed, and its canonical would point at pages that don't exist yet
  s = s.replace(/[ \t]*<link rel="canonical"[^>]*>\r?\n?/g, '');
  if (!s.includes('name="robots"')) {
    s = s.replace(/(<meta charset[^>]*>)/, '$1\n<meta name="robots" content="noindex">');
  }
  writeFileSync(file, s);
}

rmSync(tmp, { recursive: true, force: true });
const pages = [...htmlFiles(OUT)].length;
console.log(`preview refreshed: ${pages} pages under redesign/ from branch 'redesign'`);
