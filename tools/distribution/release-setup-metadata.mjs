import { readFileSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, resolve } from 'node:path';
import { isEntry } from '../entry/is-entry.mjs';
import { NPM_VERSION, REGISTRY } from './npm-release.mjs';

const NAME = /^@inventarch\/[a-z0-9-]+$/;
const CODES = new Set([
  'EOTP',
  'E401',
  'E403',
  'E404',
  'E429',
  'E500',
  'E502',
  'E503',
  'E504',
  'ENOTFOUND',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENPMVERSION',
  'ENPMCLI',
  'ECANCELED',
  'EUSAGE',
  'EMETADATARESULT',
]);
const refusal = (code) => Object.assign(new Error(code), { code });

function failureCode(error) {
  if (CODES.has(error?.code)) return error.code;
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') return 'ECANCELED';
  return 'EMETADATAFAILED';
}

function loadPinnedNpm(cli) {
  const npmRoot = resolve(dirname(cli), '..');
  const manifest = JSON.parse(readFileSync(resolve(npmRoot, 'package.json'), 'utf8'));
  if (manifest.name !== 'npm' || manifest.version !== NPM_VERSION) throw refusal('ENPMVERSION');
  const require = createRequire(resolve(npmRoot, 'package.json'));
  return { Npm: require('./lib/npm.js'), fetch: require('npm-registry-fetch'), npmRoot };
}

/**
 * Read the exact raw packument with existing npm configuration. npm view selects versions/tags and can hide an
 * existing prerelease-only or empty package. Only identity crosses this helper's boundary, never configuration,
 * credentials, response bodies or raw errors. The injected loader is solely a credential-free testing seam.
 */
export async function readPackageMetadata(cli, name, { load = loadPinnedNpm } = {}) {
  let npm;
  let result;
  try {
    if (typeof cli !== 'string' || !cli || typeof name !== 'string' || !NAME.test(name)) throw refusal('EUSAGE');
    if (basename(cli) !== 'npm-cli.js') throw refusal('ENPMCLI');
    if (REGISTRY !== 'https://registry.npmjs.org') throw refusal('EMETADATAFAILED');
    const { Npm, fetch, npmRoot } = load(cli);
    const originalArgv = process.argv;
    try {
      // Npm appends its argv option to process.argv; inherit no helper arguments or arbitrary caller options.
      process.argv = [process.execPath, cli];
      npm = new Npm({
        npmRoot,
        argv: ['--registry', REGISTRY, '--loglevel=silent', '--logs-max=0', '--timing=false', '--progress=false'],
      });
    } finally {
      process.argv = originalArgv;
    }
    // Npm.load/exec may display raw errors and write logs. Disable its listeners and load existing config only.
    npm.unload();
    await npm.config.load();
    const metadata = await fetch.json(`${REGISTRY}/${encodeURIComponent(name)}`, {
      ...npm.flatOptions,
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
    if (
      !metadata ||
      typeof metadata !== 'object' ||
      Array.isArray(metadata) ||
      metadata.name !== name ||
      !metadata.versions ||
      typeof metadata.versions !== 'object' ||
      Array.isArray(metadata.versions)
    )
      throw refusal('EMETADATARESULT');
    result = { ok: true, name };
  } catch (error) {
    result = { ok: false, code: failureCode(error) };
  } finally {
    try {
      npm?.unload();
    } catch {
      result = { ok: false, code: 'EMETADATAFAILED' };
    }
  }
  return result;
}

if (isEntry(process.argv[1], import.meta.url)) {
  let result;
  try {
    result =
      process.argv.length === 4
        ? await readPackageMetadata(process.argv[2], process.argv[3])
        : { ok: false, code: 'EUSAGE' };
  } catch {
    result = { ok: false, code: 'EMETADATAFAILED' };
  }
  // A completed failure also uses this bounded channel; an absent/malformed envelope remains unknown to setup.
  writeSync(1, `${JSON.stringify(result)}\n`);
}
