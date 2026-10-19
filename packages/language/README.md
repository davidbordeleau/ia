# @inventarch/language

[![npm](https://img.shields.io/npm/v/@inventarch/language?label=npm)](https://www.npmjs.com/package/@inventarch/language) [![Public quality](https://github.com/inventarch/ia/actions/workflows/platform-quality.yml/badge.svg?branch=main)](https://github.com/inventarch/ia/actions/workflows/platform-quality.yml) [![License](https://img.shields.io/badge/license-Apache--2.0-green)](LICENSE) [![Node](https://img.shields.io/badge/node-%3E%3D22.22.0%20%3C23-brightgreen)](package.json)

> The `.ia` language in pure TypeScript: one scanner, one parser, an explicit vocabulary registry, a semantic compiler, a loss-checked formatter and the embedded language floor. Use it to parse, register, compile and format IA text, or to edit one record of a source file.
>
> It is the first package in the dependency direction `language → graph → compliance → db → runtime → workspace-runtime`. [`@inventarch/graph`](../graph/README.md) loads the records it compiles.

## ⚡ Quick start

```sh
npm install @inventarch/language
```

```js
import { format, parse } from '@inventarch/language';

const source = `#! ia 1.0

@decision   api-response-format
  meaning
    says    "Choose a response format for the public API."
`;

const { ast, diagnostics } = parse(source, 'decision.ia');
console.log(ast.records.map((record) => `@${record.discriminator} ${record.name}`), diagnostics.length);
// [ '@decision api-response-format' ] 0

console.log(format(source, 'decision.ia').text);
// #! ia 1.0
//
// @decision api-response-format
//   meaning
//     says "Choose a response format for the public API."
```

`parse` and `format` are syntax only: nothing above checks `@decision` against a vocabulary. `compile` does, against a registry you build with `buildRegistry`, and refuses a word that no registered system declares with `IA-LANG-DISCRIMINATOR-UNREGISTERED`. A file with a syntax error formats to `text: null` with its diagnostics.

## 🧭 What it does

| Export | What it does |
| --- | --- |
| `scan(text, path)`, `parse(text, path)` | The token stream with trivia; `{ ast, diagnostics }` with records, typed fields, nesting, comments and line spans |
| `buildRegistry(sources)` | `{ registry, diagnostics }`: a frozen registry joined from the `@system` and `@schema` declarations of parsed sources, and the stage diagnostics. Only `system` and `schema` are built in; every other word needs a registration |
| `compile(ast, registry, location, pool)` | `{ records, diagnostics, sourceMap }`: identities, typed fields, relationship edges with two-sided consent, cells, selectors, variants and contract requirements. `pool` holds the admitted records of other files; a record from this file's path in `pool` is a `TypeError` |
| `resolveTarget`, `validatePool`, `requirementCollisions` | Reference resolution and whole-tree requirement uniqueness for callers that assemble many files |
| `format(source, path)`, `checkFormatPreservation(source, output, path)` | Canonical spacing that keeps comments, blank lines and multiline values; the guard reports `IA-LANG-FORMAT-LOSSY` when a candidate changes them |
| `references(ast)` | The typed references a file holds; prose is never read as a reference |
| `identityOf`, `renderIdentity`, `canonicalPath`, taxonomy constants and `is*` guards | Identity, path and closed-value helpers such as `KINDS`, `PHASES`, `PREDICATES`, `INVERSE_OF` and `VERB_PHRASES` |
| `KERNEL_SOURCES`, `KERNEL_DIGEST` | The validated language floor as frozen path and text sources, and its digest |
| `LANGUAGE_VERSION`, `SUPPORTED_VERSIONS` | The language version this package reads (`1.0`); graph's `load` and `revisionOf` take it as `languageVersion` |
| `LANG_CODES`, `consentFor`, `verbOf`, `canonicalValue` | The closed `IA-LANG-*` diagnostic codes, two-sided consent for one edge, and lookups of verb spellings and closed values |

A `Location` is `{ placement: { kind, band, reach }, provenance }`. Give it the band `BAND_OF[kind]`: graph's `load` refuses any other with a `TypeError`. Each `buildRegistry` source is `{ ast, diagnostics, location }`, such as `{ ...parse(text, path), location }`. The [graph quick start](../graph/README.md#-quick-start) compiles `KERNEL_SOURCES` this way.

The `./editor` subpath serves editors and authoring hosts:

| Export | What it does |
| --- | --- |
| `projectSource`, `cursorContext`, `lineRange`, `recordsIn`, `contains` | Zero-based UTF-16 ranges for tokens and references, and presentation-only cursor context |
| `appendRecord`, `addRelationship`, `setField`, `annotateRecord` | Return the whole file with exactly one top-level record changed; every other line keeps its bytes and line ending |
| `draftSource`, `encodeValue`, `draftValue`, `relationshipConsent` | Spell a schema-backed draft or one field value, and judge one relationship row's two-sided consent |
| `SourceEditError` | Thrown by a refused edit, with a closed `reason` such as `parse`, `identity` or `field` |

`@inventarch/runtime/editor` re-exports the source-edit functions for hosts that do not import this package. The `./internal/*` subpaths are published for IA's own toolchain; use the root and `./editor` entry points.

## ⚖️ What it does not do

- **No I/O.** It reads no files, clock, randomness, network or model, has no runtime dependencies and loads no vocabulary on its own. You supply the text, paths, registries, locations and candidate records.
- **Parsing is not admission.** A file that parses can still fail registration or compilation, and a file with any error is not loadable even when `compile` returns preview records. Resolving references across files needs the whole selected corpus, not one file.
- **Diagnostics, not verdicts.** Applying schemas to ordinary records, checking that a fragment's cell or requirement exists and evaluating contracts belong to [`@inventarch/compliance`](../compliance/README.md). Choosing the winning occurrence of an identity across bands belongs to [`@inventarch/graph`](../graph/README.md).
- **Edits return text.** `format` and the editor functions never write a file, and an edit adds no diagnostic of its own: compile the result to judge it.

## 📚 Learn more

- [SPEC.md](SPEC.md): the package contract, including the semantic, formatting, kernel and editor clauses
- [LANGUAGE.md](LANGUAGE.md): the packaged summary of the words this release ships
- [Language guide](../../docs/reference/language/README.md) and [architecture reference](../../docs/reference/architecture/README.md#which-package-to-use)
- Next in the dependency direction: [`@inventarch/graph`](../graph/README.md), [`@inventarch/compliance`](../compliance/README.md) and [`@inventarch/db`](../db/README.md)
- [Root README](../../README.md)
