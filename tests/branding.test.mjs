import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function distributionFiles(base) {
  return readdirSync(base).flatMap(name => {
    if (['.git', 'node_modules'].includes(name)) return [];
    const full = join(base, name);
    return statSync(full).isDirectory() ? distributionFiles(full) : [full];
  });
}

test('the package, extension, skill and command have one Envelope namespace', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'pi-envelope');
  assert.ok(pkg.pi.extensions.includes('./extensions/envelope/index.js'));
  assert.ok(pkg.pi.skills.includes('./skills/envelope'));
  assert.ok(existsSync(join(root, 'extensions/envelope/index.mjs')));
  assert.ok(!existsSync(join(root, 'extensions/upper')));
  assert.ok(!existsSync(join(root, 'skills/upper-envelope')));
  const source = readFileSync(join(root, 'extensions/envelope/index.mjs'), 'utf8');
  assert.match(source, /registerCommand\?\.\('envelope'/);
  assert.match(source, /name: 'envelope_recall_output'/);
});

test('shipped text contains no retired product brand or public tool prefix', () => {
  const retired = /pi-upper-envelope|upper[-_ ]envelope|\bUpperEnvelope\b|\bupperEnvelope\b|\bUPPER_ENVELOPE\b|\/upper(?:\b|\/)|\bupper_[a-z]|\bUPPER_[A-Z]/i;
  const offenders = distributionFiles(root)
    .filter(filename => relative(root, filename) !== 'tests/branding.test.mjs')
    .filter(filename => /\.(?:js|mjs|ts|json|md|go|py)$/.test(filename))
    .filter(filename => retired.test(relative(root, filename) + '\n' + readFileSync(filename, 'utf8')))
    .map(filename => relative(root, filename));
  assert.deepEqual(offenders, []);
});
