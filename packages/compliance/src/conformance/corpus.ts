import { KERNEL_DIGEST, LANGUAGE_VERSION, buildRegistry, compile, parse } from '@inventarch/language';
import type { Location } from '@inventarch/language';
import { load } from '@inventarch/graph';
import type { Graph, RevisionSource } from '@inventarch/graph';
import type { SystemFolder } from '../systems.js';

export interface Corpus {
  readonly graph: Graph;
  readonly inputs: readonly RevisionSource[];
  readonly folders: readonly SystemFolder[];
}
const floor: Location = { placement: { kind: 'floor', band: 10, reach: '' }, provenance: 'bootstrap' };
const authored: Location = { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' };
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Compiles and loads the conformance corpus the boundary suites run over. Throws on any diagnostic. */
export function loadCorpus(
  corpus: readonly { readonly path: string; readonly text: string }[],
  folderNames: readonly string[],
): Corpus {
  const inputs = [...corpus]
    .sort((a, b) => compare(a.path, b.path))
    .map(
      ({ path, text }): RevisionSource => ({
        path,
        text,
        location: path.startsWith('.ia/src/floor/') ? floor : authored,
      }),
    );
  const sources = inputs.map((input) => ({ ...parse(input.text, input.path), location: input.location }));
  const registered = buildRegistry(sources);
  if (registered.diagnostics.length > 0) throw new Error(JSON.stringify(registered.diagnostics));
  const first = sources.flatMap((s) => compile(s.ast, registered.registry, s.location, []).records);
  const records = sources.flatMap((s) => {
    const result = compile(
      s.ast,
      registered.registry,
      s.location,
      first.filter((r) => r.source.path !== s.ast.path),
    );
    if (result.diagnostics.length > 0) throw new Error(JSON.stringify(result.diagnostics));
    return result.records;
  });
  const graph = load(records, registered.registry, {
    sources: inputs,
    languageVersion: LANGUAGE_VERSION,
    kernelDigest: KERNEL_DIGEST,
    location: '',
  });
  const folders = folderNames.map((name) => {
    const path = `.ia/src/systems/${name}`;
    return {
      name,
      path,
      sources: sources.filter((s) => s.ast.path.startsWith(path + '/')),
      records: records.filter((r) => r.source.path.startsWith(path + '/')),
    };
  });
  return { graph, inputs, folders };
}
