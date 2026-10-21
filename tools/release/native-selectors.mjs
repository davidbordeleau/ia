/** Release selectors shared by native packing and the dependency-free npm release versioner. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export const NATIVE_SYSTEM_POLICY = 'tools/distribution/system-package-policy.json';
export const NATIVE_LANGUAGE_POLICY = 'examples/public-language/versions.json';
export const NATIVE_COMPOSITION_FIXTURE = 'apps/cli/tests/fixtures/composition-workspace/.ia/release.json';
const stable = (value) =>
  typeof value === 'string' &&
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) &&
  value.split('.').every((part) => Number.isSafeInteger(Number(part)));
const keys = (value, expected) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort());
const read = (root, path) => readFileSync(resolve(root, path), 'utf8');
const parse = (root, path) => JSON.parse(read(root, path));
const newline = (text, original) => (original.includes('\r\n') ? text.replace(/\r?\n/g, '\r\n') : text);
const json = (value, original) => newline(JSON.stringify(value, null, 2) + '\n', original);
const compare = (a, b) => {
  const left = a.split('.').map(Number),
    right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
};

const major = (version) => Number(version.split('.')[0]);
/**
 * The version every native identity aligns to when an npm release starts a new major, or null within a major. A new
 * major aligns natives to its `x.0.0`, so a target past `x.0.0` (reachable only by editing `releases/current.json`
 * by hand) refuses rather than aligning natives to it.
 */
export function nativeMajorAlignment(target, published) {
  assert.ok(stable(target) && stable(published), 'Native release requires stable npm versions');
  if (major(target) <= major(published)) return null;
  assert.ok(
    target === major(target) + '.0.0',
    `A new npm major aligns native archives to ${major(target)}.0.0; target ${target} skips it`,
  );
  return target;
}

export function readNativeReleaseTarget(root) {
  const policy = parse(root, 'releases/current.json');
  assert.equal(policy.format, 'ia.npm-cohort.v1', 'Invalid npm release target');
  assert.ok(stable(policy.version), 'Native release requires a stable npm target');
  assert.equal(policy.tag, 'latest', 'Only the reviewed latest publication channel is supported');
  assert.ok(keys(policy.baseline, ['commit', 'version']), 'Invalid npm published baseline');
  assert.match(policy.baseline.commit, /^[a-f0-9]{40}$/);
  assert.ok(stable(policy.baseline.version), 'Invalid npm published baseline version');
  assert.ok(
    compare(policy.version, policy.baseline.version) > 0,
    'Release version must advance the published baseline',
  );
  assert.ok(Array.isArray(policy.cycles), 'Invalid npm cycle policy');
  return policy;
}

function systemPolicy(value) {
  assert.ok(keys(value, ['format', 'packages', 'owners']), 'Invalid native system policy shape');
  assert.equal(value.format, 'ia.system-package-policy.v2');
  assert.ok(Array.isArray(value.owners) && value.owners.length, 'Missing native owners');
  assert.ok(Array.isArray(value.packages), 'Missing native package inventory');
  for (const row of value.owners) {
    assert.ok(keys(row, ['owner', 'kind', 'npmVersion', 'native']), 'Invalid native owner fields');
    const native = row.native;
    assert.ok(keys(native, ['system', 'id', 'version', 'distribution']), 'Invalid native identity fields');
    assert.match(native.system, /^[a-z][a-z0-9-]*$/);
    assert.notEqual(native.system, 'language', 'Language is not a system owner');
    assert.equal(row.owner, '.ia/src/systems/' + native.system, 'Native owner path differs from identity');
    assert.equal(native.id, 'inventarch/' + native.system, 'Native system identity differs');
    assert.equal(native.distribution, 'workspace-system/definition/distribution/package-' + native.system);
    assert.ok(['compiled', 'native-only'].includes(row.kind), 'Invalid native owner kind');
    assert.ok(stable(row.npmVersion) && stable(native.version), 'Invalid native owner version');
  }
  const owners = value.owners.map((row) => row.owner);
  assert.equal(new Set(owners).size, owners.length, 'Duplicate native owner');
  assert.equal(new Set(value.packages).size, value.packages.length, 'Duplicate native package');
  assert.deepEqual([...value.packages].sort(), [...owners].sort(), 'Native package membership differs from owners');
  return value;
}
function languagePolicy(value) {
  assert.ok(keys(value, ['format', 'language']), 'Invalid native language policy shape');
  assert.equal(value.format, 'ia.public-native-versions.v1');
  assert.ok(stable(value.language), 'Invalid native language version');
  return value;
}
/** This one test descriptor follows the bundled language; no other dependency range is a release selector. */
function compositionFixture(value, systems) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'Invalid composition fixture');
  assert.equal(value.id, 'local/demo', 'Invalid composition fixture identity');
  assert.ok(
    Array.isArray(value.dependencies) && value.dependencies.length === 1,
    'Invalid composition fixture dependencies',
  );
  const dependency = value.dependencies[0];
  assert.ok(keys(dependency, ['id', 'range', 'systems']), 'Invalid composition fixture dependency');
  assert.equal(dependency.id, 'inventarch/language', 'Invalid composition fixture dependency identity');
  assert.ok(
    typeof dependency.range === 'string' && dependency.range.startsWith('^') && stable(dependency.range.slice(1)),
    'Invalid composition fixture range',
  );
  assert.ok(Array.isArray(dependency.systems), 'Invalid composition fixture systems');
  assert.deepEqual(
    [...dependency.systems].sort(),
    systems.owners.map((owner) => owner.native.system).sort(),
    'Invalid composition fixture systems',
  );
  return value;
}
function selection(root) {
  const system = existsSync(resolve(root, NATIVE_SYSTEM_POLICY));
  const language = existsSync(resolve(root, NATIVE_LANGUAGE_POLICY));
  if (!system && !language) {
    assert.ok(
      !['.ia/src/systems', 'examples/public-language', 'releases/native', NATIVE_COMPOSITION_FIXTURE].some((path) =>
        existsSync(resolve(root, path)),
      ),
      'Incomplete native selector surface',
    );
    return null;
  }
  assert.ok(system && language, 'Incomplete native selector surface');
  return {
    systems: systemPolicy(parse(root, NATIVE_SYSTEM_POLICY)),
    language: languagePolicy(parse(root, NATIVE_LANGUAGE_POLICY)),
  };
}
/** Locate a version inside the selected system record, never a later record's similarly named field. */
function declarationSpan(text, system) {
  const names = [...text.matchAll(/^@system ([a-z][a-z0-9-]*)\r?$/gm)];
  assert.ok(text.startsWith('#! ia 1.0\n') || text.startsWith('#! ia 1.0\r\n'), 'Native syntax header changed');
  assert.equal(names.length, 1, 'Native file must declare exactly one system');
  if (system !== undefined) assert.equal(names[0][1], system, 'Native declaration identity differs from owner');
  const bodyStart = names[0].index + names[0][0].length;
  const following = /^@[a-z][a-z0-9-]*(?:[ \r\n]|$)/m.exec(text.slice(bodyStart));
  const bodyEnd = following ? bodyStart + following.index : text.length;
  const matches = [...text.slice(bodyStart, bodyEnd).matchAll(/^  version "([^"\r\n]+)"\r?$/gm)];
  assert.equal(matches.length, 1, 'Native declaration must have exactly one version');
  assert.ok(stable(matches[0][1]), 'Invalid native declaration version');
  const start = bodyStart + matches[0].index + '  version "'.length;
  return { version: matches[0][1], start, end: start + matches[0][1].length };
}
const declaration = (text, system) => declarationSpan(text, system).version;
/** Only the selected declaration version may change; preserve headers and all other bytes. */
export function declarationVersion(text, from, to) {
  assert.ok(stable(from) && stable(to), 'Stable native declaration versions are required');
  const span = declarationSpan(text);
  assert.equal(span.version, from, 'Native declaration differs from selected policy');
  return text.slice(0, span.start) + to + text.slice(span.end);
}
const declarationPaths = (owner) => [
  owner.owner + '/system.ia',
  'examples/public-language/contracts/' + owner.native.system + '.ia',
];

const LANGUAGE_ID = 'inventarch/language';
const versionsOf = (selected) =>
  Object.fromEntries([
    [LANGUAGE_ID, selected.language.language],
    ...selected.systems.owners.map((owner) => [owner.native.id, owner.native.version]),
  ]);
/** The native version each identity selects now, language included, or undefined without a native surface. */
export function selectedNativeVersions(root) {
  const selected = selection(root);
  return selected ? versionsOf(selected) : undefined;
}
/**
 * The native versions an npm release selects before any archive is rebuilt: every identity at the target of a new
 * major, otherwise each as currently selected. Within a major, content decides, and only `pnpm native:version` can
 * judge content, so the npm versioner never moves a native version there.
 */
export function releaseNativeVersions(root, published, target) {
  assert.ok(stable(published) && stable(target), 'Native release requires stable npm versions');
  const current = selectedNativeVersions(root);
  if (!current) return undefined;
  const alignment = nativeMajorAlignment(target, published);
  return alignment ? Object.fromEntries(Object.keys(current).map((id) => [id, alignment])) : current;
}
/** Whether `releases/native/notes.json` describes native changes against the published `v<published>` tag. */
export function nativeNotesPending(root, published, commit) {
  const path = resolve(root, 'releases/native/notes.json');
  if (!existsSync(path)) return false;
  const notes = JSON.parse(readFileSync(path, 'utf8'));
  return (
    notes?.baseline?.tag === 'v' + published &&
    (commit === undefined || notes.baseline.commit === commit) &&
    Array.isArray(notes.changes) &&
    notes.changes.length > 0
  );
}

/**
 * Prepare every exact selector before any effect. Generic npm fixtures may omit the entire native surface. Every npm
 * version moves to `target`; each native identity moves to its version in `native`, or stays as selected when it is
 * omitted, and the composition fixture follows the language. A native version may not fall below the current
 * selection unless `lowerSelected` is set: the native writer sets it, since an unpublished selection can move back
 * down with its notes, and it enforces the published floor itself.
 */
export function prepareNativeSelection(root, target, native, { lowerSelected = false } = {}) {
  assert.ok(stable(target), 'Native release requires a stable npm target');
  const selected = selection(root),
    writes = new Map();
  if (!selected) return writes;
  const current = versionsOf(selected),
    versions = native ?? current;
  assert.deepEqual(Object.keys(versions).sort(), Object.keys(current).sort(), 'Native identity inventory changed');
  for (const [id, version] of Object.entries(versions)) {
    assert.ok(stable(version), id + ': invalid native version');
    assert.ok(lowerSelected || compare(version, current[id]) >= 0, id + ': native version regressed');
  }
  for (const owner of selected.systems.owners) {
    assert.ok(compare(target, owner.npmVersion) >= 0, owner.native.id + ': npm version regressed');
    for (const path of declarationPaths(owner)) {
      const text = read(root, path);
      assert.equal(
        declaration(text, owner.native.system),
        owner.native.version,
        'Native declaration differs from selected policy',
      );
      writes.set(path, declarationVersion(text, owner.native.version, versions[owner.native.id]));
    }
    owner.native.version = versions[owner.native.id];
    owner.npmVersion = target;
  }
  const language = versions[LANGUAGE_ID];
  if (existsSync(resolve(root, NATIVE_COMPOSITION_FIXTURE))) {
    const fixture = compositionFixture(parse(root, NATIVE_COMPOSITION_FIXTURE), selected.systems);
    assert.ok(
      lowerSelected || compare(language, fixture.dependencies[0].range.slice(1)) >= 0,
      'Composition fixture version regressed',
    );
    fixture.dependencies[0].range = '^' + language;
    writes.set(NATIVE_COMPOSITION_FIXTURE, json(fixture, read(root, NATIVE_COMPOSITION_FIXTURE)));
  }
  selected.language.language = language;
  writes.set(NATIVE_SYSTEM_POLICY, json(selected.systems, read(root, NATIVE_SYSTEM_POLICY)));
  writes.set(NATIVE_LANGUAGE_POLICY, json(selected.language, read(root, NATIVE_LANGUAGE_POLICY)));
  return writes;
}

/** Fresh proof for one existing exact path. Stored coverage flags never substitute for this comparison. */
export function nativeVersionOnly(root, path, beforeText, afterText) {
  if (typeof beforeText !== 'string' || typeof afterText !== 'string') return false;
  if (
    path !== NATIVE_COMPOSITION_FIXTURE &&
    path !== NATIVE_SYSTEM_POLICY &&
    path !== NATIVE_LANGUAGE_POLICY &&
    !path.startsWith('.ia/src/systems/') &&
    !path.startsWith('examples/public-language/contracts/')
  )
    return false;
  try {
    const selected = selection(root);
    if (!selected) return false;
    if (path === NATIVE_COMPOSITION_FIXTURE) {
      const before = compositionFixture(JSON.parse(beforeText), selected.systems),
        after = compositionFixture(JSON.parse(afterText), selected.systems);
      before.dependencies[0].range = '^0.0.0';
      after.dependencies[0].range = '^0.0.0';
      return isDeepStrictEqual(before, after);
    }
    if (path === NATIVE_SYSTEM_POLICY) {
      const before = systemPolicy(JSON.parse(beforeText)),
        after = systemPolicy(JSON.parse(afterText));
      for (const policy of [before, after])
        for (const owner of policy.owners) {
          owner.native.version = '0.0.0';
          owner.npmVersion = '0.0.0';
        }
      return isDeepStrictEqual(before, after);
    }
    if (path === NATIVE_LANGUAGE_POLICY) {
      const before = languagePolicy(JSON.parse(beforeText)),
        after = languagePolicy(JSON.parse(afterText));
      return isDeepStrictEqual({ ...before, language: '0.0.0' }, { ...after, language: '0.0.0' });
    }
    const owner = selected.systems.owners.find((row) => declarationPaths(row).includes(path));
    if (!owner) return false;
    const before = declaration(beforeText, owner.native.system),
      after = declaration(afterText, owner.native.system);
    return (
      declarationVersion(beforeText, before, '0.0.0').replace(/\r\n/g, '\n') ===
      declarationVersion(afterText, after, '0.0.0').replace(/\r\n/g, '\n')
    );
  } catch {
    return false;
  }
}
