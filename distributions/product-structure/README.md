# Product structure

[![Public quality](https://github.com/inventarch/ia/actions/workflows/platform-quality.yml/badge.svg?branch=main)](https://github.com/inventarch/ia/actions/workflows/platform-quality.yml) [![License](https://img.shields.io/badge/license-Apache--2.0-green)](../../LICENSE)

> This directory is the source of `inventarch/product-structure`, an optional IA distribution. It defines `product-system`, which owns one word, `@product`: a stable product identity that groups `@plan` records under an `@agent` owner. The `inventarch/language` base does not include it; a workspace gets the word only by installing this distribution, which is versioned independently of the IA toolchain.

## What it ships

| Part | What it is |
| --- | --- |
| `product-system` records | The system, the `@product` schema, its steward and authoring guide, the release `@workspace` and `@distribution`, a `@contract` and four `@case` records, all under `.ia/src/systems/product-system/` |
| `consumer.mjs`, `consumer.d.mts` | `readProduct(snapshot, identity, revision?)`, a pure structural reader over an admitted `EditorSnapshot` from `@inventarch/db/editor` |
| Documentation | This README, the [distribution contract](SPEC.md), the [product authoring guide](.ia/src/systems/product-system/README.md), the [product architecture](.ia/src/systems/product-system/SPEC.md) and the [`@product` schema guide](.ia/src/systems/product-system/schemas/product.SPEC.md) |
| Dependency | The `inventarch/language` base at one exact version, which supplies every other system the product schema uses |

The archive carries only `product-system`. Records that use `@product` belong to a system of the consumer's own that requires `product-system`.

## A product record

```ia
@product customer-portal
  meaning
    says "A stable independently authored product"
    answers "Which product groups these plans?"
  product
    format 1
    title "Customer portal"
    status proposed
    owner @agent product-editor
    plans [@plan portal-plan]
```

The schema is closed. It requires `meaning.says`, `meaning.answers`, `product.format` (a number), `product.title`, `product.status` (`proposed`, `active` or `retired`), `product.owner` (a reference to an `@agent`) and `product.plans` (a list of `@plan` references). `product.description` is optional.

## Two checks, not one

Generic native admission checks required fields, the closed shape, status values and the word each reference names. A dangling reference can pass it with only a warning. `readProduct` adds the product rules and throws when one fails:

| Error | Thrown when |
| --- | --- |
| `PRODUCT_ADMISSION` | The snapshot has an error finding, a refused source or a blocked system, or the requested revision is not the snapshot's revision |
| `PRODUCT_IDENTITY` | No `@product` owned by `product-system` has that identity |
| `PRODUCT_FIELDS` | `format` is not exactly `1`, `title` is blank, or `status` is outside the three values |
| `PRODUCT_REFERENCE` | `owner` does not resolve to an `@agent`, a plan does not resolve to a `@plan`, or a plan appears twice |

On success it returns the identity, revision, title, status, owner identity and plan identities. A generic dangling-reference warning is never a successful product read.

## Build and test from source

From a built source checkout, pack the language and product archives into a new directory. The command refuses a directory that already exists:

```sh
node --conditions=development --import tsx tools/release/product-structure.mjs <new-output-directory>
```

It writes the two digest-named `.ia.tgz` archives and `product-artifacts.json`, which records the exact language pin and the product's archive and manifest digests, systems and dependencies. Besides the `.ia` records, the archive holds a fixed list of files: the documentation above, the reader, and the repository LICENSE and NOTICE. The packer publishes nothing.

The product archive does not verify on its own, because its authoring guides resolve only through its language dependency. A consumer installs it with `ia install` from a registry that has published both archives.

```sh
pnpm --dir apps/distribution exec vitest run --config vitest.config.mts tests/product-structure.test.ts
```

These tests cover explicit adoption, a product identity that survives title and status changes, stale-revision refusal, the shape, format, title and reference refusals above, and packing a second owned system for a kit.

## What it does not do

- Installing the distribution never runs `consumer.mjs` or grants it authority. A caller selects the reader explicitly.
- `owner` is an authored association, not authenticated membership or an access right.
- `retired` is authored domain state. It deletes, revokes and runs nothing.
- Application directory mappings, lifecycle policy and effects belong to the consumer.
- Extending products needs a separate local system with explicit references. Registering `@product` again or patching the installed schema is unsupported.

Licensed under Apache-2.0. Source: [inventarch/ia](https://github.com/inventarch/ia).
