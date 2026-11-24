import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { checkSourceBoundaries } from '../scripts/check-boundaries.mjs';

const root = path.resolve('/virtual/ubve-boundary-fixture');
const check = (packageName, source) => checkSourceBoundaries(source, path.join(root, 'packages', packageName, 'src', 'index.ts'), root);
const rejects = (packageName, source, pattern) => assert.ok(check(packageName, source).some(message => pattern.test(message)), source);

test('production rejects testkit package imports, subpaths, exports and import types', () => {
  for (const source of [
    "import { FakeCodec } from '@ubve/testkit';",
    "export { FakeCodec } from '@ubve/testkit/fake-codec';",
    "type Fake = import('@ubve/testkit').FakeCodec;",
    "type Module = typeof import('@ubve/testkit/internal');",
    "const module = await import('@ubve/testkit');",
    "const module = await import(`@ubve/testkit/internal`);",
    "import fixture = require('@ubve/testkit');",
  ]) rejects('browser', source, /testkit may not enter production/);
});

test('production rejects normalized relative paths into testkit source or output', () => {
  for (const source of [
    "import { FakeCodec } from '../../testkit/src/index.js';",
    "export * from '../../testkit/dist/index.js';",
    "type Fake = import('../../testkit/src/../src/index.js').FakeCodec;",
    "const module = await import('../../testkit/src/index.js');",
    "const module = require('../../testkit/dist/index.js');",
  ]) rejects('browser', source, /testkit may not enter production/);
});

test('core keeps relative imports within its own source tree', () => {
  assert.deepEqual(check('core', "import type { ByteLength } from './units.js'; export * from './output.js';"), []);
  for (const source of [
    "import type { Decoder } from '@ubve/core';",
    "export * from '../../browser/src/index.js';",
    "type Fake = import('../../testkit/src/index.js').FakeCodec;",
    "const helpers = import('../outside-src.js');",
  ]) rejects('core', source, /core must use only its own relative modules/);
});

test('testkit imports only its own package and the admitted core interface', () => {
  assert.deepEqual(check('testkit', "import { EngineError } from '@ubve/core'; import './manual-scheduler.js';"), []);
  rejects('testkit', "import '../../browser/src/index.js';", /unexpected testkit dependency/);
  rejects('testkit', "type Host = import('@ubve/browser').BrowserPlayer;", /unexpected testkit dependency/);
});

test('engine imports reject Node, Vue subpaths and computed dynamic imports', () => {
  for (const name of ['node:fs', 'fs', 'fs/promises', 'vue', 'vue/server-renderer']) {
    rejects('browser', `import '${name}';`, /forbidden engine dependency/);
  }
  rejects('browser', 'const module = import(selectedPackage);', /computed module imports/);
});

test('browser accepts supported core imports and does not conflate package prefixes', () => {
  assert.deepEqual(check('browser', [
    "import type { Session } from '@ubve/core';",
    "export type { Decoder } from '@ubve/core';",
    "type Configuration = import('@ubve/core').DecoderConfiguration;",
    "import './local-helper.js';",
    "import '@ubve/testkit-extra';",
  ].join('\n')), []);
});
