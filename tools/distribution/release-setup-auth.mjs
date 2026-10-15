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
  'ENOTFOUND',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTTY',
  'ENPMVERSION',
  'ENPMCLI',
  'EAUTHRESPONSE',
  'ECANCELED',
  'EUSAGE',
]);
const refusal = (code) => Object.assign(new Error(code), { code });

/** npm's accepted OTP formats, with masked input and no remembered default or log output. */
export async function readMaskedOtp(prompt, { read, input, meta }) {
  while (true) {
    const value = await input.read(() => read({ prompt, silent: true }), { [meta]: true, silent: true });
    if (typeof value === 'string' && /^[\d ]+$|^[A-Fa-f0-9]{64,64}$/.test(value)) return value.replace(/\s+/g, '');
  }
}

function failureCode(error) {
  if (CODES.has(error?.code)) return error.code;
  if (
    error?.name === 'AbortError' ||
    error?.code === 'ABORT_ERR' ||
    error?.message === 'canceled' ||
    error?.message === 'cancelled'
  )
    return 'ECANCELED';
  return 'EAUTHFAILED';
}

function loadPinnedNpm(cli) {
  const npmRoot = resolve(dirname(cli), '..');
  if (basename(cli) !== 'npm-cli.js') throw refusal('ENPMCLI');
  const manifest = JSON.parse(readFileSync(resolve(npmRoot, 'package.json'), 'utf8'));
  if (manifest.name !== 'npm' || manifest.version !== NPM_VERSION) throw refusal('ENPMVERSION');
  const require = createRequire(resolve(npmRoot, 'package.json'));
  const userInfo = require('./lib/utils/read-user-info.js');
  const { read } = require('read');
  const { input, META: meta } = require('proc-log');
  return {
    Npm: require('./lib/npm.js'),
    Display: require('./lib/utils/display.js'),
    TrustList: require('./lib/commands/trust/list.js'),
    npmRoot,
    maskOtp: () => {
      const original = userInfo.otp;
      userInfo.otp = (prompt) => readMaskedOtp(prompt, { read, input, meta });
      return () => {
        userInfo.otp = original;
      };
    },
  };
}

/**
 * npm 12.2.0's otplease requires real terminal stdin AND stdout and applies its OTP only to the retried request.
 * Use its read-only command and native prompts, but return the successful response separately from terminal text.
 * The module loader/TTY inputs are seams for credential-free tests; the CLI exposes neither as an option.
 */
export async function readTrustInteractive(
  cli,
  name,
  { stdinIsTTY = process.stdin.isTTY, stdoutIsTTY = process.stdout.isTTY, load = loadPinnedNpm } = {},
) {
  let npm;
  let display;
  let restoreOtp;
  try {
    if (!stdinIsTTY || !stdoutIsTTY) throw refusal('ENOTTY');
    if (typeof cli !== 'string' || !NAME.test(name)) throw refusal('EUSAGE');
    const { Npm, Display, TrustList, npmRoot, maskOtp } = load(cli);
    const originalArgv = process.argv;
    try {
      // Npm's constructor appends its argv option to process.argv. Do not inherit helper or arbitrary CLI flags.
      process.argv = [process.execPath, cli];
      npm = new Npm({
        npmRoot,
        argv: [
          'trust',
          'list',
          name,
          '--registry',
          REGISTRY,
          '--json=false',
          '--loglevel=silent',
          '--logs-max=0',
          '--timing=false',
          '--progress=false',
        ],
      });
    } finally {
      process.argv = originalArgv;
    }
    // Npm.load/exec format raw errors and may write log files. Load existing configuration only; never login/save.
    npm.unload();
    await npm.config.load();
    display = new Display({ stdout: process.stdout, stderr: process.stderr });
    await display.load({
      heading: 'npm',
      json: false,
      loglevel: 'silent',
      progress: false,
      stderrColor: false,
      stdoutColor: false,
      timing: false,
      unicode: false,
    });
    restoreOtp = maskOtp();
    const command = new TrustList(npm);
    let listing;
    command.displayResponseBody = ({ body, packageName }) => {
      if (listing !== undefined || packageName !== name || !body || typeof body !== 'object')
        throw refusal('EAUTHRESPONSE');
      const items = Array.isArray(body) ? body : [body];
      listing = items
        .map((item) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) throw refusal('EAUTHRESPONSE');
          // Match npm's JSON normalization, including all entries: multiple configs remain ambiguous to trustState.
          const value = TrustList.bodyToOptions(item);
          if (item.permissions) value.permissions = item.permissions;
          return JSON.stringify(value);
        })
        .join('\n');
    };
    await command.exec([name]);
    if (listing === undefined) throw refusal('EAUTHRESPONSE');
    return { ok: true, listing };
  } catch (error) {
    return { ok: false, code: failureCode(error) };
  } finally {
    restoreOtp?.();
    display?.off();
    npm?.unload();
  }
}

if (isEntry(process.argv[1], import.meta.url)) {
  let result;
  try {
    result =
      process.argv.length === 4
        ? await readTrustInteractive(process.argv[2], process.argv[3])
        : { ok: false, code: 'EUSAGE' };
  } catch {
    result = { ok: false, code: 'EAUTHFAILED' };
  }
  // fd 0/1/2 stay attached to the terminal. Only this bounded response crosses fd 3; never raw errors or OTPs.
  try {
    writeSync(3, `${JSON.stringify(result)}\n`);
  } catch {
    result = { ok: false, code: 'EAUTHFAILED' };
  }
  process.exitCode = result.ok ? 0 : 1;
}
