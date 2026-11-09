// Copies the files the live site needs from site/ into dist/, which the Web stack uploads to the site bucket.
// Only files in git are copied: the generated photos (site/p, site/k, site/t) go to the media bucket instead, through
// infra/script/publish_photos.sh, and site/ on Nathan's Mac also holds design experiments that are not the site.
//
//   npm run build            (APP_VERSION=<sha> stamps the build, as CI does)
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'site');
const DIST = join(ROOT, 'dist');

/** Everything the page loads from the site bucket. Keep in step with the <script>/<link> tags in gallery.html. */
const FILES = [
  'gallery.html',
  'portfolio.js',
  'shared/core.css',
  'shared/core.js',
  'favicon.ico',
  'favicon-32x32.png',
  'apple-touch-icon.png',
  'est/headshots.jpg',
  'est/portraits.jpg',
  'est/senior.jpg',
  'est/engagement.jpg',
  'est/events.jpg',
];

rmSync(DIST, { recursive: true, force: true });
for (const file of FILES) {
  const from = join(SITE, file);
  if (!existsSync(from)) throw new Error(`[build] site/${file} is missing`);
  mkdirSync(dirname(join(DIST, file)), { recursive: true });
  cpSync(from, join(DIST, file));
}

// gallery.html is written as a fragment for the artifact host, which adds the document skeleton. On S3 nothing does,
// so add it here: without the charset the browser may decode the page as Latin-1 (and the CSP script hash no longer
// matches), and without the viewport phones render it at desktop width.
const page = join(DIST, 'gallery.html');
const source = readFileSync(page, 'utf8');
if (!/^\s*<!doctype/i.test(source)) {
  const head = [
    '<!doctype html>',
    '<html lang="en">',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    '<meta name="description" content="Nathan Jones Photography: aviation, landscapes, portraits, cities and events from Kentucky and beyond.">',
  ].join('\n');
  writeFileSync(page, `${head}\n${source.replace(/^\s*<meta name="claude:[^>]*>\n?/m, '')}`);
}

const version = process.env.APP_VERSION ?? 'local';
writeFileSync(join(DIST, 'version.json'), `${JSON.stringify({ version, built: new Date().toISOString() })}\n`);

const html = readFileSync(join(DIST, 'gallery.html'), 'utf8');
for (const [, ref] of html.matchAll(/<(?:script[^>]*\bsrc|link[^>]*\bhref)="(?!https?:)([^"?$]+)"/g)) {
  if (!existsSync(join(DIST, ref))) throw new Error(`[build] gallery.html loads ${ref}, which is not in FILES`);
}
console.log(`Built dist/ (${FILES.length} files, version ${version})`);
