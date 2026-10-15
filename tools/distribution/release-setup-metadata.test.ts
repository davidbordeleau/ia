import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { NPM_VERSION, REGISTRY } from './npm-release.mjs';
import { readPackageMetadata } from './release-setup-metadata.mjs';

const name = '@inventarch/runner';
const cli = resolve('fixture/npm/bin/npm-cli.js');
const secret = 'fixture-secret-never-returned';

function fixture(metadata: unknown = { name, versions: {} }) {
  const events: string[] = [];
  const construct = vi.fn();
  const configLoad = vi.fn(async () => {
    events.push('config load');
  });
  const unload = vi.fn(() => {
    events.push('npm unload');
  });
  const options = {
    '//registry.npmjs.org/:_authToken': secret,
    registry: 'https://other.example',
    '@inventarch:registry': 'https://scope.example',
    offline: true,
    preferOffline: true,
    preferOnline: false,
    timeout: 900_000,
    fetchRetries: 9,
    otpPrompt: vi.fn(),
  };
  const json = vi.fn(async (_url: string, _options: Record<string, unknown>) => {
    events.push('metadata read');
    return metadata;
  });
  class Npm {
    constructor(options: { npmRoot: string; argv: string[] }) {
      construct(options, [...process.argv]);
    }
    config = { load: configLoad };
    flatOptions = options;
    unload = unload;
  }
  const load = vi.fn(() => ({ Npm, fetch: { json }, npmRoot: resolve('fixture/npm') }));
  return { load, json, construct, configLoad, unload, events, options };
}

it.each([
  { name, versions: {}, private: true },
  { name, versions: { '0.0.0-bootstrap.0': { name, version: '0.0.0-bootstrap.0' } } },
  { name, versions: { '1.2.3': { name, version: '1.2.3' } }, 'dist-tags': { other: '1.2.3' } },
  { name, versions: { '1.2.3': { name, version: '1.2.3' } }, 'dist-tags': { latest: '1.2.3' } },
])('recognizes exact raw metadata without requiring a version, latest tag or public visibility (%j)', async (body) => {
  const test = fixture({ ...body, secret });
  await expect(readPackageMetadata(cli, name, test)).resolves.toEqual({ ok: true, name });
});

it('loads existing configuration quietly and performs one fresh GET to the canonical exact-package URL', async () => {
  const test = fixture();
  const originalArgv = process.argv;
  const result = await readPackageMetadata(cli, name, test);
  expect(result).toEqual({ ok: true, name });
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(test.construct).toHaveBeenCalledExactlyOnceWith(
    {
      npmRoot: resolve('fixture/npm'),
      argv: ['--registry', REGISTRY, '--loglevel=silent', '--logs-max=0', '--timing=false', '--progress=false'],
    },
    [process.execPath, cli],
  );
  expect(process.argv).toBe(originalArgv);
  expect(test.json).toHaveBeenCalledExactlyOnceWith(`${REGISTRY}/%40inventarch%2Frunner`, {
    ...test.options,
    registry: REGISTRY,
    '@inventarch:registry': REGISTRY,
    spec: name,
    method: 'GET',
    offline: false,
    preferOffline: false,
    preferOnline: true,
    timeout: 30_000,
    fetchRetries: 0,
    otpPrompt: undefined,
  });
  expect(test.options.registry).toBe('https://other.example');
  expect(test.options.otpPrompt).not.toHaveBeenCalled();
  expect(test.configLoad).toHaveBeenCalledOnce();
  expect(test.events).toEqual(['npm unload', 'config load', 'metadata read', 'npm unload']);
});

it.each([
  null,
  undefined,
  '',
  'not-json',
  [],
  {},
  { name: '@inventarch/other', versions: {} },
  { name },
  { name, versions: null },
  { name, versions: [] },
  { name, versions: 'private-data' },
])('refuses malformed or wrong-package metadata (%j)', async (metadata) => {
  const test = fixture(metadata);
  // undefined is intentionally returned, rather than using fixture's default value.
  test.json.mockResolvedValueOnce(metadata);
  await expect(readPackageMetadata(cli, name, test)).resolves.toEqual({ ok: false, code: 'EMETADATARESULT' });
  expect(test.unload).toHaveBeenCalledTimes(2);
});

it.each(['E404', 'E401', 'E403', 'EOTP', 'E429', 'E503', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT'])(
  'returns only the allowlisted %s code and never starts authentication or retries',
  async (code) => {
    const test = fixture();
    test.json.mockRejectedValueOnce(Object.assign(new Error(secret), { code, body: secret }));
    await expect(readPackageMetadata(cli, name, test)).resolves.toEqual({ ok: false, code });
    expect(test.json).toHaveBeenCalledOnce();
    expect(test.options.otpPrompt).not.toHaveBeenCalled();
    expect(test.unload).toHaveBeenCalledTimes(2);
  },
);

it.each([
  Object.assign(new Error(secret), { code: secret }),
  new Error(`E404 ${secret}`),
  { message: secret, statusCode: 404 },
  secret,
])('does not infer a safe code from unstructured error details (%j)', async (error) => {
  const test = fixture();
  test.json.mockRejectedValueOnce(error);
  await expect(readPackageMetadata(cli, name, test)).resolves.toEqual({ ok: false, code: 'EMETADATAFAILED' });
});

it.each([{ name: 'AbortError' }, { code: 'ABORT_ERR' }])('sanitizes cancelled reads (%j)', async (error) => {
  const test = fixture();
  test.json.mockRejectedValueOnce({ ...error, message: secret });
  await expect(readPackageMetadata(cli, name, test)).resolves.toEqual({ ok: false, code: 'ECANCELED' });
});

it('cleans up after configuration failure without issuing a request or leaking configuration', async () => {
  const test = fixture();
  test.configLoad.mockRejectedValueOnce(new Error(secret));
  await expect(readPackageMetadata(cli, name, test)).resolves.toEqual({ ok: false, code: 'EMETADATAFAILED' });
  expect(test.json).not.toHaveBeenCalled();
  expect(test.unload).toHaveBeenCalledTimes(2);
});

it('restores caller arguments when npm construction fails and sanitizes loader failures', async () => {
  const originalArgv = process.argv;
  const test = fixture();
  test.construct.mockImplementationOnce(() => {
    throw new Error(secret);
  });
  await expect(readPackageMetadata(cli, name, test)).resolves.toEqual({ ok: false, code: 'EMETADATAFAILED' });
  expect(process.argv).toBe(originalArgv);
  expect(test.json).not.toHaveBeenCalled();
  test.load.mockImplementationOnce(() => {
    throw new Error(secret);
  });
  await expect(readPackageMetadata(cli, name, test)).resolves.toEqual({ ok: false, code: 'EMETADATAFAILED' });
});

it('discards success if cleanup fails, without exposing the cleanup exception', async () => {
  const test = fixture();
  test.unload
    .mockImplementationOnce(() => {})
    .mockImplementationOnce(() => {
      throw new Error(secret);
    });
  await expect(readPackageMetadata(cli, name, test)).resolves.toEqual({ ok: false, code: 'EMETADATAFAILED' });
});

it.each(['other-package', '@other/runner', '@inventarch/runner --otp=secret', '@inventarch/runner@latest'])(
  'refuses invalid package %s before loading npm',
  async (packageName) => {
    const test = fixture();
    await expect(readPackageMetadata(cli, packageName, test)).resolves.toEqual({ ok: false, code: 'EUSAGE' });
    expect(test.load).not.toHaveBeenCalled();
  },
);

it('refuses a different executable before loading any modules', async () => {
  const test = fixture();
  await expect(readPackageMetadata(resolve('fixture/arbitrary.js'), name, test)).resolves.toEqual({
    ok: false,
    code: 'ENPMCLI',
  });
  expect(test.load).not.toHaveBeenCalled();
});

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it.each([
  { name: 'npm', version: '12.2.1' },
  { name: 'other', version: NPM_VERSION },
])('refuses an installation outside the exact pinned npm contract (%j)', async (manifest) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'ia-metadata-contract-'));
  temporary.push(directory);
  mkdirSync(resolve(directory, 'bin'));
  writeFileSync(resolve(directory, 'package.json'), JSON.stringify(manifest));
  await expect(readPackageMetadata(resolve(directory, 'bin/npm-cli.js'), name)).resolves.toEqual({
    ok: false,
    code: 'ENPMVERSION',
  });
});

it('returns only a structured refusal for extra helper options without loading npm', () => {
  const result = spawnSync(
    process.execPath,
    [resolve(import.meta.dirname, 'release-setup-metadata.mjs'), cli, name, '--registry=https://other.example'],
    { stdio: 'pipe', encoding: 'utf8', timeout: 10_000 },
  );
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout).toBe(`${JSON.stringify({ ok: false, code: 'EUSAGE' })}\n`);
});
