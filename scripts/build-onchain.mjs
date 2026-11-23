#!/usr/bin/env node
/**
 * Deterministic single-file build for the on-chain DeWEB web container.
 *
 * web/index.html references ./cloud-membership.js as an external script. The
 * on-chain build replaces that one tag with two inline scripts:
 *   <script>{tape-direct.bundle.js}</script>
 *   <script>{cloud-membership.js}</script>
 * Nothing else is transformed, so the output is byte-for-byte reproducible.
 *
 * Usage:
 *   node scripts/build-onchain.mjs
 *   node scripts/build-onchain.mjs --expect <sha256>
 *   node scripts/build-onchain.mjs --out <path> --upload-copy
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const webDir = path.join(repo, 'web');
const TAG_TEXT = '<script src="./cloud-membership.js"></script>';

function fail(message) {
  console.error('ERROR ' + message);
  process.exit(1);
}

function option(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fallback;
  return process.argv[i + 1] ?? fallback;
}

function flag(name) {
  return process.argv.includes('--' + name);
}

const srcPath = path.join(webDir, 'index.html');
const bundlePath = path.join(webDir, 'tape-direct.bundle.js');
const membershipPath = path.join(webDir, 'cloud-membership.js');
const outPath = path.resolve(option('out', path.join(repo, '..', 'deweb-onchain-build', 'index.direct.html')));
const expect = option('expect', null);

for (const p of [srcPath, bundlePath, membershipPath]) {
  if (!fs.existsSync(p)) fail('missing input: ' + p);
}

const src = fs.readFileSync(srcPath);
const tag = Buffer.from(TAG_TEXT);
const at = src.indexOf(tag);
if (at < 0) fail('index.html is missing the exact tag: ' + TAG_TEXT);
if (src.indexOf(tag, at + tag.length) >= 0) fail('index.html contains the tag more than once');

const bundle = fs.readFileSync(bundlePath);
const membership = fs.readFileSync(membershipPath);
const inline = Buffer.concat([
  Buffer.from('<script>\n'),
  bundle,
  Buffer.from('\n</script>\n<script>\n'),
  membership,
  Buffer.from('\n</script>')
]);
const out = Buffer.concat([src.subarray(0, at), inline, src.subarray(at + tag.length)]);

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, out);

const sha = crypto.createHash('sha256').update(out).digest('hex');
console.log('WROTE  ' + outPath);
console.log('BYTES  ' + out.length);
console.log('SHA256 ' + sha);

if (flag('upload-copy')) {
  const upload = path.join(repo, '..', 'upload-page', 'index.upload.html');
  fs.copyFileSync(outPath, upload);
  console.log('COPIED ' + upload);
}

if (expect) {
  const want = String(expect).replace(/^0x/i, '').toLowerCase();
  if (want !== sha) fail('sha256 mismatch: expected ' + want + ' got ' + sha);
  console.log('MATCH  ' + want);
}
