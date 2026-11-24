import { readdir, readFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nodeModules = new Set(builtinModules.map(name => name.replace(/^node:/, '')));

const inside = (directory, target) => {
  const relative = path.relative(directory, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

const packageAt = (workspaceRoot, file) => {
  const relative = path.relative(path.join(workspaceRoot, 'packages'), file);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return relative.split(path.sep)[0] || null;
};

/** Pure source check: no module execution, imports, or filesystem probes.
 * Relative references are normalized before assigning destination ownership;
 * @ubve subpaths retain the ownership of their package.
 */
export function checkSourceBoundaries(sourceText, file, workspaceRoot = root) {
  const failures = [];
  const packageName = packageAt(workspaceRoot, file);
  if (!packageName) return [`${file}: source is outside the workspace package graph`];
  const sourceRoot = path.join(workspaceRoot, 'packages', packageName, 'src');
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.ES2023, true);
  const checkSpecifier = specifier => {
    if (!specifier || !ts.isStringLiteralLike(specifier)) {
      failures.push(`${file}: computed module imports need an explicit reviewed boundary`);
      return;
    }
    const name = specifier.text;
    const isRelative = name.startsWith('./') || name.startsWith('../');
    const resolved = isRelative || path.isAbsolute(name) ? path.resolve(path.dirname(file), name) : null;
    const destination = resolved ? packageAt(workspaceRoot, resolved) : /^@ubve\/([^/]+)(?:\/|$)/.exec(name)?.[1] ?? null;

    if (packageName === 'core' && (!isRelative || !inside(sourceRoot, resolved))) {
      failures.push(`${file}: core must use only its own relative modules (${name})`);
    }
    if (packageName === 'testkit') {
      const allowed = isRelative ? destination === 'testkit' || destination === 'core' : name === '@ubve/core';
      if (!allowed) failures.push(`${file}: unexpected testkit dependency ${name}`);
    }
    if (packageName !== 'testkit' && destination === 'testkit') {
      failures.push(`${file}: testkit may not enter production assembly (${name})`);
    }
    if (packageName !== 'testkit' && (name.startsWith('node:') || nodeModules.has(name) || name === 'vue' || name.startsWith('vue/'))) {
      failures.push(`${file}: forbidden engine dependency ${name}`);
    }
  };
  const inspect = node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      checkSpecifier(node.moduleSpecifier);
    } else if (ts.isImportTypeNode(node)) {
      checkSpecifier(ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      checkSpecifier(node.moduleReference.expression);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      checkSpecifier(node.arguments[0]);
    }
    ts.forEachChild(node, inspect);
  };
  inspect(source);
  return failures;
}

const list = async directory => {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await list(name));
    else if (name.endsWith('.ts')) result.push(name);
  }
  return result;
};

async function main() {
  const failures = [];
  for (const entry of await readdir(path.join(root, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageName = entry.name;
    const sourceRoot = path.join(root, 'packages', packageName, 'src');
    let files;
    try { files = await list(sourceRoot); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const file of files) {
      failures.push(...checkSourceBoundaries(await readFile(file, 'utf8'), file));
    }
  }
  if (failures.length) { for (const failure of failures) console.error(failure); process.exitCode = 1; }
  else console.log('Import boundaries passed for all implemented engine packages.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
