import { afterEach, expect, it, vi } from 'vitest';
import { fetchBounded } from '../src/bounded-fetch.js';

afterEach(() => {
  vi.unstubAllGlobals();
});
const digest = 'a'.repeat(64);
/** A fetch stub that records each requested URL and answers `ok`; every request must refuse redirects. */
function recording(): string[] {
  const requested: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    expect(init?.redirect).toBe('error');
    requested.push(String(input));
    return new Response('ok');
  });
  return requested;
}
const get = (url: string) =>
  fetchBounded({ url, limit: 16, label: 'Test request', oversize: () => 'Test response exceeds 16 bytes' });
/**
 * The callers' own URL test, without the archive's digest suffix: the archive check (`readArtifactBytes`,
 * apps/distribution/src/acquire.ts:19-29) and the lock decoder's `url`
 * (packages/db/src/distribution/contracts.ts:124-135) both require HTTPS in the form `new URL` writes, with no
 * userinfo and no query or fragment as `URL` reads them. Every registry document URL passes it too: a base the
 * registry parser serialized, with no `?` or `#` at all, followed by a `portable` lowercase document path.
 */
function produced(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash &&
      parsed.href === url
    );
  } catch {
    return false;
  }
}

it('fetches every URL form registry documents and remote archives produce, as written', async () => {
  const forms = [
    'https://registry.test/base/ia-registry.json',
    'https://registry.test:8443/base/packages/acme/tools.json',
    'https://registry.test:65535/kits/acme/kit/index.json',
    'https://registry.test:0/workspaces/acme/space/index.json',
    'https://127.0.0.1:8443/ia-registry.json',
    `https://[::1]:8443/base/artifacts/${digest}.ia.tgz`,
    `https://[::ffff:7f00:1]/${digest}.ia.tgz`,
    'https://[2001:db8::1]/ia-registry.json',
    'https://xn--bcher-kva.test/base/ia-registry.json',
    'https://re_g!"$&\'()*+,;=`{}~istry.test/ia-registry.json',
    'https://registry.test/a%20b/%C3%A9/%22%3C%3E%60%7B%7D/%7e%zz%/ia-registry.json',
    "https://registry.test/!$&'()*+,;=:@[]^_|~-./ia-registry.json",
    `https://example.invalid/Mixed/CASE//${digest}.ia.tgz`,
    // `URL.search` and `URL.hash` read an empty query or fragment as none, so the archive check admits a bare `?` or `#`.
    `https://example.invalid/${digest}.ia.tgz?`,
    `https://example.invalid/${digest}.ia.tgz#`,
    `https://example.invalid/${digest}.ia.tgz?#`,
  ];
  for (const url of forms) expect(produced(url), url).toBe(true);
  const requested = recording();
  for (const url of forms) expect((await get(url))?.toString(), url).toBe('ok');
  expect(requested).toEqual(forms);
});

it('fetches every canonical spelling of a host or path character that a caller can produce', async () => {
  // Each printable ASCII character in a host and in a path, raw and as `new URL` rewrites it (the registry parser keeps
  // the rewrite, the archive check admits only an exact spelling), then non-ASCII, uppercase and long-form input.
  const raw: string[] = [];
  for (let code = 0x20; code < 0x7f; code += 1) {
    const c = String.fromCharCode(code);
    raw.push(
      `https://a${c}b.test/`,
      `https://registry.test/x${c}y/ia-registry.json`,
      `https://registry.test:8443/${c}/${digest}.ia.tgz`,
    );
  }
  raw.push(
    'https://BÜCHER.test/É/ia-registry.json',
    'https://registry.test/日本/ia-registry.json',
    'HTTPS://[0:0:0:0:0:0:0:1]:08443/ia-registry.json',
    'https://127.1/ia-registry.json',
  );
  const forms = [
    ...new Set(
      raw.flatMap((value) => {
        try {
          return [value, new URL(value).href];
        } catch {
          return [];
        }
      }),
    ),
  ].filter(produced);
  for (const form of [
    'https://a_b.test/',
    'https://a~b.test/',
    'https://registry.test/x%y/ia-registry.json',
    'https://registry.test/x%20y/ia-registry.json',
    'https://registry.test/x|y/ia-registry.json',
    `https://registry.test:8443/^/${digest}.ia.tgz`,
    'https://xn--bcher-kva.test/%C3%89/ia-registry.json',
    'https://registry.test/%E6%97%A5%E6%9C%AC/ia-registry.json',
    'https://[::1]:8443/ia-registry.json',
    'https://127.0.0.1/ia-registry.json',
  ])
    expect(forms, form).toContain(form);
  const requested = recording();
  for (const url of forms) expect((await get(url))?.toString(), url).toBe('ok');
  expect(requested).toEqual(forms);
});

it('refuses, before any request, a URL that is not a canonical credential-free HTTPS URL without query or fragment', async () => {
  const refused = [
    // Credentials, empty ones included.
    'https://user:secret@registry.test/ia-registry.json',
    'https://user@registry.test/ia-registry.json',
    'https://@registry.test/ia-registry.json',
    'https://:@registry.test/ia-registry.json',
    // A query or a fragment.
    'https://registry.test/ia-registry.json?token=1',
    'https://registry.test/ia-registry.json?token',
    'https://registry.test/ia-registry.json??',
    'https://registry.test/ia-registry.json#part',
    'https://registry.test/ia-registry.json?#part',
    'https://registry.test/ia-registry.json#?',
    'https://registry.test/ia-registry.json##',
    // Another scheme, the scheme in another case, or no scheme.
    'http://registry.test/ia-registry.json',
    'HTTPS://registry.test/ia-registry.json',
    'Https://registry.test/ia-registry.json',
    'ftp://registry.test/ia-registry.json',
    'wss://registry.test/ia-registry.json',
    'file:///registry/ia-registry.json',
    'data:text/plain,ia',
    'https:registry.test/ia-registry.json',
    'https:/registry.test/ia-registry.json',
    '//registry.test/ia-registry.json',
    'registry.test/ia-registry.json',
    '',
    // A host with uppercase letters or characters serialization never writes there; a `?`, `#` or backslash where
    // the host ends, which `new URL` reads as the start of a query, a fragment or the path (so
    // `https://evil.test#.registry.test/…` and `https://evil.test\registry.test/…` request evil.test, and
    // `https://registry.test?token=1/…` sends a query); an IPv6 literal that is broken or in uppercase or dotted
    // form; or no host.
    'https://Registry.test/ia-registry.json',
    'https://REGISTRY.TEST/ia-registry.json',
    'https://bücher.test/ia-registry.json',
    'https://regi%73try.test/ia-registry.json',
    'https://regi^stry.test/ia-registry.json',
    'https://regi|stry.test/ia-registry.json',
    'https://regi<stry.test/ia-registry.json',
    'https://regi>stry.test/ia-registry.json',
    'https://regi stry.test/ia-registry.json',
    'https://registry.test?/ia-registry.json',
    'https://registry.test#/ia-registry.json',
    'https://registry.test?token=1/ia-registry.json',
    'https://evil.test#.registry.test/ia-registry.json',
    'https://evil.test\\registry.test/ia-registry.json',
    'https://registry.test\\ia-registry.json',
    'https:///ia-registry.json',
    'https://[::1/ia-registry.json',
    'https://[::G]/ia-registry.json',
    'https://[::1]x/ia-registry.json',
    'https://[::A]/ia-registry.json',
    'https://[::ffff:127.0.0.1]/ia-registry.json',
    // A port that is empty, too long or not decimal.
    'https://registry.test:/ia-registry.json',
    'https://registry.test:123456/ia-registry.json',
    'https://registry.test:84a3/ia-registry.json',
    // No path, or a path with a space, a control, non-ASCII or a character serialization percent-encodes.
    'https://registry.test',
    'https://registry.test/a b/ia-registry.json',
    'https://registry.test/a\tb/ia-registry.json',
    'https://registry.test/a\nb/ia-registry.json',
    'https://registry.test/é/ia-registry.json',
    'https://registry.test/a"b/ia-registry.json',
    'https://registry.test/a<b>/ia-registry.json',
    'https://registry.test/a`b/ia-registry.json',
    'https://registry.test/a{b}/ia-registry.json',
    'https://registry.test/a\\b/ia-registry.json',
    // Surrounding whitespace.
    ' https://registry.test/ia-registry.json',
    'https://registry.test/ia-registry.json ',
    'https://registry.test/ia-registry.json\n',
  ];
  const requested = recording();
  for (const url of refused) {
    // None of these is a URL either caller admits: the archive check's own test refuses each one.
    expect(produced(url), JSON.stringify(url)).toBe(false);
    await expect(get(url), JSON.stringify(url)).rejects.toMatchObject({
      code: 'IA-DIST-INPUT-INVALID',
      message: `Test request ${url} is not a canonical credential-free HTTPS URL without query or fragment`,
    });
  }
  expect(requested).toEqual([]);
});

it('refuses each ASCII character in a host or requests exactly the host the URL spells', async () => {
  // This stub reads the host as fetch parses the request, so a character that ends or reshapes the host shows up.
  const hosts: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    expect(init?.redirect).toBe('error');
    hosts.push(new URL(new Request(input, init).url).host);
    return new Response('ok');
  });
  let admitted = '';
  // Every ASCII character, controls included: URL parsing drops a tab or newline, so one admitted in a host would
  // request a different host.
  for (let code = 0; code < 0x80; code += 1) {
    const c = String.fromCharCode(code),
      url = `https://a${c}b.test/ia-registry.json`,
      // The host the URL spells: everything between `https://` and the first `/`.
      spelled = url.slice('https://'.length, url.indexOf('/', 'https://'.length));
    const refusal = await get(url).then(
      () => undefined,
      (error: unknown) => error,
    );
    if (refusal === undefined) {
      expect(hosts.pop(), url).toBe(spelled);
      admitted += c;
    } else expect(refusal, url).toMatchObject({ code: 'IA-DIST-INPUT-INVALID' });
  }
  // The characters the check admits in a host, and `/`, which ends it.
  expect(admitted).toBe('!"$&\'()*+,-./0123456789;=_`abcdefghijklmnopqrstuvwxyz{}~');
  expect(hosts).toEqual([]);
});

it('checks the shape, not the canonical form: fetch requests a rewritten spelling as it parses it, or fails to', async () => {
  // This stub builds the request as fetch does, so a URL it cannot parse throws fetch's own TypeError.
  const requested: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    expect(init?.redirect).toBe('error');
    requested.push(new Request(input, init).url);
    return new Response('ok');
  });
  const rewritten: readonly (readonly [string, string])[] = [
    ['https://registry.test:443/ia-registry.json', 'https://registry.test/ia-registry.json'],
    ['https://127.1/ia-registry.json', 'https://127.0.0.1/ia-registry.json'],
    ['https://2130706433/ia-registry.json', 'https://127.0.0.1/ia-registry.json'],
    ['https://0x7f.1/ia-registry.json', 'https://127.0.0.1/ia-registry.json'],
    ['https://0/ia-registry.json', 'https://0.0.0.0/ia-registry.json'],
    ['https://registry.test/a/../ia-registry.json', 'https://registry.test/ia-registry.json'],
    ['https://registry.test/%2e/ia-registry.json', 'https://registry.test/ia-registry.json'],
  ];
  for (const [url, parsed] of rewritten) {
    expect(produced(url), url).toBe(false);
    expect((await get(url))?.toString(), url).toBe('ok');
    expect(requested.pop(), url).toBe(parsed);
  }
  for (const url of [
    'https://registry.test:99999/ia-registry.json',
    'https://[:::]/ia-registry.json',
    'https://xn--/ia-registry.json',
    'https://xn--a/ia-registry.json',
    'https://1.2.3.4.5/ia-registry.json',
  ]) {
    // fetch's own wording varies with the Node version; the code and the URL that the message names are the
    // contract (§6.4).
    const failure = await get(url).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure, url).toMatchObject({ code: 'IA-DIST-ARTIFACT-UNAVAILABLE' });
    expect((failure as Error).message.startsWith(`Test request ${url} failed: `), url).toBe(true);
  }
  expect(requested).toEqual([]);
});
