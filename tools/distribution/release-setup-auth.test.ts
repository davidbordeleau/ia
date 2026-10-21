import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { NPM_VERSION, REGISTRY } from './npm-release.mjs';
import { readMaskedOtp, readTrustInteractive } from './release-setup-auth.mjs';
import { trustState } from './release-setup.mjs';

const name = '@inventarch/runner';
const cli = resolve('fixture/npm/bin/npm-cli.js');
const rawTrust = {
  id: 'tp_fixture',
  type: 'github',
  permissions: ['createPackage'],
  claims: { repository: 'inventarch/ia', workflow_ref: { file: 'npm-publish.yml' }, environment: 'npm' },
};
type Response = { body: unknown; packageName: string };

function fixture(
  operation: (respond: (response: Response) => void) => Promise<void> = async (respond) => {
    respond({ body: [rawTrust], packageName: name });
  },
) {
  const events: string[] = [];
  const construct = vi.fn();
  const configLoad = vi.fn(async () => {
    events.push('config load');
  });
  const unload = vi.fn(() => {
    events.push('npm unload');
  });
  const displayLoad = vi.fn(async (_options: Record<string, unknown>) => {
    events.push('display load');
  });
  const displayOff = vi.fn(() => {
    events.push('display off');
  });
  const restoreOtp = vi.fn(() => {
    events.push('restore otp');
  });
  const maskOtp = vi.fn(() => {
    events.push('mask otp');
    return restoreOtp;
  });
  const execute = vi.fn(async (args: string[], respond: (response: Response) => void) => {
    expect(args).toEqual([name]);
    events.push('read');
    await operation(respond);
    events.push('read complete');
  });
  class Npm {
    constructor(options: { npmRoot: string; argv: string[] }) {
      construct(options, [...process.argv]);
    }
    config = { load: configLoad };
    unload = unload;
  }
  class Display {
    load = displayLoad;
    off = displayOff;
  }
  class TrustList {
    displayResponseBody = (_response: Response) => {
      throw new Error('Uncaptured response');
    };
    exec = async (args: string[]) => execute(args, this.displayResponseBody);
    static bodyToOptions(item: Record<string, unknown>) {
      const claims = item['claims'] as typeof rawTrust.claims | undefined;
      return {
        id: item['id'],
        type: item['type'],
        repository: claims?.repository,
        file: claims?.workflow_ref?.file,
        environment: claims?.environment,
      };
    }
  }
  const load = vi.fn(() => ({ Npm, Display, TrustList, npmRoot: resolve('fixture/npm'), maskOtp }));
  return {
    options: { stdinIsTTY: true, stdoutIsTTY: true, load },
    events,
    construct,
    configLoad,
    unload,
    displayLoad,
    displayOff,
    execute,
    load,
    restoreOtp,
  };
}

it.each([
  [false, false],
  [false, true],
  [true, false],
])(
  'refuses interactive recovery with terminal stdin %s and stdout %s before loading npm',
  async (stdinIsTTY, stdoutIsTTY) => {
    const test = fixture();
    await expect(readTrustInteractive(cli, name, { ...test.options, stdinIsTTY, stdoutIsTTY })).resolves.toEqual({
      ok: false,
      code: 'ENOTTY',
    });
    expect(test.load).not.toHaveBeenCalled();
  },
);

it.each(['other-package', '@other/runner', '@inventarch/runner --otp=secret'])(
  'refuses unexpected package %s',
  async (packageName) => {
    const test = fixture();
    await expect(readTrustInteractive(cli, packageName, test.options)).resolves.toEqual({ ok: false, code: 'EUSAGE' });
    expect(test.load).not.toHaveBeenCalled();
  },
);

it('keeps native prompts separate and returns only a fully completed read with normal trust verification', async () => {
  const test = fixture();
  const originalArgv = process.argv;
  const result = await readTrustInteractive(cli, name, test.options);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('Expected listing');
  expect(trustState(result.listing).state).toBe('configured');
  expect(test.construct).toHaveBeenCalledWith(
    {
      npmRoot: resolve('fixture/npm'),
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
    },
    [process.execPath, cli],
  );
  expect(process.argv).toBe(originalArgv);
  expect(test.displayLoad).toHaveBeenCalledWith(expect.objectContaining({ json: false, loglevel: 'silent' }));
  expect(test.events).toEqual([
    'npm unload',
    'config load',
    'display load',
    'mask otp',
    'read',
    'read complete',
    'restore otp',
    'display off',
    'npm unload',
  ]);
  expect(test.configLoad).toHaveBeenCalledOnce();
  expect(test.execute).toHaveBeenCalledOnce();
});

it('preserves different trust and multiple responses for the strict existing verifier', async () => {
  const different = { ...rawTrust, claims: { ...rawTrust.claims, repository: 'someone/else' } };
  const one = await readTrustInteractive(
    cli,
    name,
    fixture(async (respond) => {
      respond({ body: [different], packageName: name });
    }).options,
  );
  expect(one.ok && trustState(one.listing).state).toBe('different');
  const several = await readTrustInteractive(
    cli,
    name,
    fixture(async (respond) => {
      respond({ body: [rawTrust, different], packageName: name });
    }).options,
  );
  expect(several.ok && trustState(several.listing).state).toBe('unknown');
});

it('returns empty listing only when the successful response explicitly has no configurations', async () => {
  const test = fixture(async (respond) => {
    respond({ body: [], packageName: name });
  });
  await expect(readTrustInteractive(cli, name, test.options)).resolves.toEqual({ ok: true, listing: '' });
});

it.each([null, undefined, '', [null], ['invalid'], [[rawTrust]]])('refuses a malformed response (%j)', async (body) => {
  const test = fixture(async (respond) => {
    respond({ body, packageName: name });
  });
  await expect(readTrustInteractive(cli, name, test.options)).resolves.toEqual({ ok: false, code: 'EAUTHRESPONSE' });
  expect(test.displayOff).toHaveBeenCalledOnce();
});

it('does not accept a response for a different package, a duplicate callback, or no completed response', async () => {
  for (const operation of [
    async (respond: (response: Response) => void) => {
      respond({ body: [], packageName: '@inventarch/language' });
    },
    async (respond: (response: Response) => void) => {
      respond({ body: [], packageName: name });
      respond({ body: [], packageName: name });
    },
    async () => {},
  ]) {
    await expect(readTrustInteractive(cli, name, fixture(operation).options)).resolves.toEqual({
      ok: false,
      code: 'EAUTHRESPONSE',
    });
  }
});

it.each(['EOTP', 'E401', 'E403', 'E404', 'ECONNRESET'])(
  'returns only %s after failed authentication/read',
  async (code) => {
    const test = fixture(async () => {
      throw Object.assign(new Error('private response token-secret'), { code });
    });
    await expect(readTrustInteractive(cli, name, test.options)).resolves.toEqual({ ok: false, code });
    expect(test.execute).toHaveBeenCalledOnce();
    expect(test.displayOff).toHaveBeenCalledOnce();
    expect(test.unload).toHaveBeenCalledTimes(2);
    expect(test.restoreOtp).toHaveBeenCalledOnce();
  },
);

it.each([new Error('canceled'), Object.assign(new Error('secret'), { name: 'AbortError' })])(
  'sanitizes cancelled authentication and never retries it',
  async (error) => {
    const test = fixture(async () => {
      throw error;
    });
    await expect(readTrustInteractive(cli, name, test.options)).resolves.toEqual({ ok: false, code: 'ECANCELED' });
    expect(test.execute).toHaveBeenCalledOnce();
  },
);

it('discards a response when the operation subsequently fails and hides unrecognized error details', async () => {
  const test = fixture(async (respond) => {
    respond({ body: [rawTrust], packageName: name });
    throw Object.assign(new Error('private token-secret'), { code: 'private-token-secret' });
  });
  await expect(readTrustInteractive(cli, name, test.options)).resolves.toEqual({ ok: false, code: 'EAUTHFAILED' });
});

it('cleans up a failed configuration load without starting a command or exposing its error', async () => {
  const test = fixture();
  test.configLoad.mockRejectedValueOnce(new Error('private configuration'));
  await expect(readTrustInteractive(cli, name, test.options)).resolves.toEqual({ ok: false, code: 'EAUTHFAILED' });
  expect(test.execute).not.toHaveBeenCalled();
  expect(test.unload).toHaveBeenCalledTimes(2);
});

it.each(['123456', '123 456', 'a'.repeat(64)])(
  'masks valid classic OTP input without remembering it (%s)',
  async (value) => {
    const meta = Symbol('test meta');
    const read = vi.fn(async () => value);
    const input = { read: vi.fn(async (operation: () => Promise<string>) => operation()) };
    await expect(readMaskedOtp('Enter OTP:', { read, input, meta })).resolves.toBe(value.replace(/\s+/g, ''));
    expect(read).toHaveBeenCalledExactlyOnceWith({ prompt: 'Enter OTP:', silent: true });
    expect(input.read).toHaveBeenCalledWith(expect.any(Function), { [meta]: true, silent: true });
  },
);

it('reprompts invalid classic input without echo or default and propagates cancellation', async () => {
  const cancelled = new Error('canceled');
  const read = vi.fn().mockResolvedValueOnce('not-an-otp').mockRejectedValueOnce(cancelled);
  const input = { read: async (operation: () => Promise<string>) => operation() };
  await expect(readMaskedOtp('Enter OTP:', { read, input, meta: Symbol('meta') })).rejects.toBe(cancelled);
  expect(read.mock.calls).toEqual([[{ prompt: 'Enter OTP:', silent: true }], [{ prompt: 'Enter OTP:', silent: true }]]);
});

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it.each([
  { name: 'npm', version: '12.2.1' },
  { name: 'other', version: NPM_VERSION },
])('refuses a CLI package outside the exact pinned contract (%j)', async (manifest) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'ia-auth-contract-'));
  temporary.push(directory);
  mkdirSync(resolve(directory, 'bin'));
  writeFileSync(resolve(directory, 'package.json'), JSON.stringify(manifest));
  await expect(
    readTrustInteractive(resolve(directory, 'bin/npm-cli.js'), name, {
      stdinIsTTY: true,
      stdoutIsTTY: true,
    }),
  ).resolves.toEqual({ ok: false, code: 'ENPMVERSION' });
});

it('writes noninteractive refusal exclusively to the dedicated result descriptor', () => {
  const result = spawnSync(process.execPath, [resolve(import.meta.dirname, 'release-setup-auth.mjs'), cli, name], {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 10_000,
  });
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('');
  expect(JSON.parse(String(result.output[3]))).toEqual({ ok: false, code: 'ENOTTY' });
});
