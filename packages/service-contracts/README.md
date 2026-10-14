# @inventarch/service-contracts

[![npm](https://img.shields.io/npm/v/@inventarch/service-contracts?label=npm)](https://www.npmjs.com/package/@inventarch/service-contracts) [![Public quality](https://github.com/inventarch/ia/actions/workflows/platform-quality.yml/badge.svg?branch=main)](https://github.com/inventarch/ia/actions/workflows/platform-quality.yml) [![License](https://img.shields.io/badge/license-Apache--2.0-green)](LICENSE) [![Node](https://img.shields.io/badge/node-22.x-brightgreen)](package.json)

> `@inventarch/service-contracts` holds browser-safe structural wire contracts between an independently supplied IA service host and its clients: strict Zod schemas for requests, responses and views, with JSON Schema export. Zod is its only runtime dependency, and importing any export starts no filesystem, network, identity, native runtime, provider or storage work. It stands apart from the `@inventarch/language` to `@inventarch/workspace-runtime` stack and imports none of it.

## ⚡ Quick start

```sh
npm install @inventarch/service-contracts
```

Decode a request against its contract, and export the contract as JSON Schema:

```js
import { decode, jsonSchema, ServiceError } from '@inventarch/service-contracts';
import { workspaceRequest } from '@inventarch/service-contracts/tenancy';

console.log(decode(workspaceRequest, { workspaceId: 'ws-1' }));

try {
  decode(workspaceRequest, { workspaceId: 'ws-1', role: 'owner' });
} catch (error) {
  if (error instanceof ServiceError) console.log(error.category, error.code);
}

console.log(jsonSchema(workspaceRequest).additionalProperties);
```

```text
{ workspaceId: 'ws-1' }
invalid invalid-request
false
```

`decode` returns the parsed value or throws a `ServiceError` with a category and a code. Objects reject unknown fields, so the extra `role` is refused rather than ignored. `jsonSchema` returns draft-07 JSON Schema. The package also re-exports `z` from Zod, with `SERVICE_VERSION` and `LIMITS`.

## 🧭 What it does

| Entry point | Contracts |
| --- | --- |
| `.` | Version and limits, binding, offering and operation descriptors, invocation, public sessions and events, errors, strict decoding and JSON Schema |
| `./tenancy` | Organization, department, membership and workspace commands, views and pages |
| `./sources` | Exact source references, upload, history and admission, and bounded file chunks |
| `./session-lifecycle` | Session directory summaries, continuation and deadline renewal |
| `./source-apply` | Exact candidates, preparation, review, application and bounded inspection |
| `./marketplace` | Native release descriptors, publication selectors, acquisition quotes and receipts, bounded artifact chunks, and registry kit and workspace indexes |
| `./installation` | Installation planning, explicit review, application and inspection |

The `./internal/*` subpaths expose the same pure modules for compatibility; they expand no authority.

## ⚖️ What it does not do

- **It validates message shape, nothing more.** Authentication, current tenancy authorization, disclosure filtering, exact source byte verification, semantic admission, replay, scheduler fencing and effects belong to the application host that serves these messages.
- **Data is never a grant.** Selectors, the permissions a published view lists, command IDs, digests and opaque tokens are data, not authority.
- **It ships no implementation.** There is no SQL-backed directory, marketplace implementation, transport or inspection method here, only contracts.
- **Its qualification proves an interoperable boundary.** Release checks install a packed consumer that imports every subpath and bundles for a browser target. They do not establish hosted authentication, deployment, registry publication or a complete application journey.

## 📚 Learn more

- [SPEC.md](SPEC.md): the contract for each export, its limits and its release qualification.
- [LANGUAGE.md](LANGUAGE.md): the public vocabulary this release carries.
- The [root README](../../README.md) and the [architecture reference](../../docs/reference/architecture/README.md).
- Related: [`@inventarch/runtime`](../runtime/README.md), whose `./authoring` subpath holds the remote authoring client contracts.
