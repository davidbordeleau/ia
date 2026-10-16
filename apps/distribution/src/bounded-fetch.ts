import { DistributionError, fail } from './files.js';

/**
 * One GET under the installer's transport bounds, shared by registry documents and remote archives.
 * `label` opens every transport refusal ("<label> <url> returned 503", "<label> <url> failed: …"); `oversize` is the
 * LIMIT-EXCEEDED message when the declared (`grew: false`) or streamed (`grew: true`) size passes `limit`.
 * `optional` reads a 404 as `null` and an absent body as empty; otherwise both refuse like any other non-OK status.
 */
export interface BoundedFetch {
  readonly url: string;
  readonly limit: number;
  readonly label: string;
  readonly oversize: (grew: boolean) => string;
  readonly optional?: boolean;
  readonly signal?: AbortSignal | undefined;
}
/**
 * A 30 s timeout joined to the caller's signal, redirects refused, declared and streamed bytes bounded (spec §5.1, §6.4),
 * and, whatever the caller checked, no request for a URL outside the shape of a canonical credential-free HTTPS URL
 * without query or fragment: that refuses as INPUT-INVALID, naming the URL after `label`.
 */
export async function fetchBounded(request: BoundedFetch): Promise<Buffer | null> {
  const { url, signal } = request;
  // §6.4: a network failure, the 30 s timeout included, names the URL; only the caller's own abort stays an abort.
  try {
    return await transfer(request);
  } catch (error) {
    if (error instanceof DistributionError || signal?.aborted === true) throw error;
    // undici reports every transport failure as "fetch failed" and keeps the reason (redirect, ECONNREFUSED, …) in `cause`.
    const cause =
      error instanceof Error && error.cause instanceof Error && error.cause.message ? ` (${error.cause.message})` : '';
    return fail(
      'ARTIFACT-UNAVAILABLE',
      `${request.label} ${url} failed: ${error instanceof Error ? error.message : String(error)}${cause}`,
    );
  }
}
async function transfer(request: BoundedFetch): Promise<Buffer | null> {
  const { url, limit, label, oversize, optional = false, signal } = request;
  // A URL is requested only in the shape `new URL` writes for an `https:` URL without userinfo, query or fragment.
  // The pattern below, part by part:
  //   ^https:\/\/                                 the scheme, then `//`;
  //   (?:[a-z0-9!"$&'()*+,;=_`{}~.-]+             a host of lowercase ASCII letters, digits and !"$&'()*+,-.;=_`{}~,
  //     |\[[0-9a-f:]+\])                          which covers names and IPv4 addresses, or an IPv6 address in
  //                                               brackets, of lowercase hex digits and `:`;
  //   (?::[0-9]{1,5})?                            an optional decimal port;
  //   \/[a-zA-Z0-9!$%&'()*+,;=:@\[\]^_|~.\/-]*     a path that starts with `/`, of ASCII letters, digits, `%` and
  //                                               !$&'()*+,-./:;=@[]^_|~;
  //   \??#?$                                      then at most a bare `?`, then at most a bare `#`.
  // It checks that shape, not the canonical form: an IPv4 number form such as `127.1`, an explicit `:443` or a dot
  // segment passes and is requested as fetch parses it. A bare `?`, `#` or `?#` passes because `URL.search` and
  // `URL.hash` read that empty query or fragment as none, as the archive and lock checks do. The pattern uses explicit
  // character classes only and tests the very URL that is fetched, and the `return` ends the refusing branch, so
  // CodeQL sees that `fetch` is reached only after the test passes: keep the literal inline and keep the `return`.
  if (
    !/^https:\/\/(?:[a-z0-9!"$&'()*+,;=_`{}~.-]+|\[[0-9a-f:]+\])(?::[0-9]{1,5})?\/[a-zA-Z0-9!$%&'()*+,;=:@\[\]^_|~.\/-]*\??#?$/.test(
      url,
    )
  )
    return fail(
      'INPUT-INVALID',
      `${label} ${url} is not a canonical credential-free HTTPS URL without query or fragment`,
    );
  const timeout = AbortSignal.timeout(30_000),
    combined = signal === undefined ? timeout : AbortSignal.any([timeout, signal]);
  const response = await fetch(url, { redirect: 'error', signal: combined });
  if (!response.ok || (!response.body && !optional)) {
    await response.body?.cancel();
    if (optional && response.status === 404) return null;
    fail('ARTIFACT-UNAVAILABLE', `${label} ${url} returned ${response.status}`);
  }
  if (!response.body) return Buffer.alloc(0);
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    await response.body.cancel();
    fail('LIMIT-EXCEEDED', oversize(false));
  }
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  let cancellation: Promise<void> | undefined;
  const cancel = (): void => {
    cancellation = reader.cancel(combined.reason);
    void cancellation.catch(() => {});
  };
  combined.addEventListener('abort', cancel, { once: true });
  try {
    combined.throwIfAborted();
    for (;;) {
      const next = await reader.read();
      combined.throwIfAborted();
      if (next.done) break;
      size += next.value.length;
      if (size > limit) fail('LIMIT-EXCEEDED', oversize(true));
      chunks.push(next.value);
    }
  } finally {
    combined.removeEventListener('abort', cancel);
    try {
      await (cancellation ?? reader.cancel());
    } finally {
      reader.releaseLock();
    }
  }
  combined.throwIfAborted();
  return Buffer.concat(chunks);
}
