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
 * The archive check's own test (`readArtifactBytes` in acquire.ts, without its digest suffix): HTTPS in the form `new URL`
 * writes, with no userinfo and no query or fragment as `URL` reads them. Every registry document URL passes it too: a
 * base the registry parser serialized, with no `?` or `#` at all, followed by a `portable` lowercase document path.
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
