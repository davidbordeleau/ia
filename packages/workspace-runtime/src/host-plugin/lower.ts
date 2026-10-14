import { createHash } from 'node:crypto';
import { claudeProseCatalog, PROSE_EFFECT_TOOLS } from '../projection-host.js';
import { HostPluginError } from './errors.js';
import type { FrontField, FrontValue } from './frontmatter.js';
import { MANIFESTS, NAME, type PluginEntry, type PluginHost, type PluginInventory } from './inventory.js';

export type AssetRole = 'asset' | 'documentation' | 'license';
export type DispositionKind = 'field' | 'resource' | 'asset' | 'derived' | 'retired' | 'unresolved';
export interface Disposition {
  readonly source: string;
  readonly key: string | null;
  readonly kind: DispositionKind;
  readonly target: string;
  readonly reason: string | null;
}
export interface LoweringMap {
  readonly format: 'ia.lowering-map.v1';
  readonly plugin: string;
  readonly system: string;
  readonly entries: readonly Disposition[];
}
export interface LoweredFile {
  readonly path: string;
  readonly bytes: Buffer;
}
export interface LoweredRecord {
  readonly word: string;
  readonly name: string;
  readonly path: string;
}
export interface LoweringPlan {
  readonly system: string;
  readonly files: readonly LoweredFile[];
  readonly records: readonly LoweredRecord[];
  readonly assets: readonly { readonly path: string; readonly role: AssetRole }[];
  readonly map: LoweringMap;
  readonly unresolved: readonly string[];
}

export const RESOURCE_ROOT = (system: string): string => `.ia/src/systems/${system}/plugin`;
export const RECORDS_PATH = (system: string): string => `.ia/src/systems/${system}/records/plugin.ia`;
const SYSTEM_PATH = (system: string): string => `.ia/src/systems/${system}/system.ia`;
export const ASSET_ROOT = 'assets/plugin';
export const IDENTITY = Object.freeze({
  capability: (name: string): string => `agent-composition-system/definition/capability/${name}`,
  profile: (name: string): string => `agent-composition-system/binding/agent-profile/${name}`,
});
const HOST_ORDER: readonly PluginHost[] = ['claude', 'codex', 'grok'];
const CLAUDE_TOOLS = new Map(claudeProseCatalog('0'.repeat(64)).tools.map((tool) => [tool.id, tool.name]));
/** Host tool names for a list of effects, in table order, without repeats. */
export function toolsOf(effects: readonly string[]): string[] {
  return [
    ...new Set(
      effects.flatMap((effect) => PROSE_EFFECT_TOOLS.get(effect) ?? []).map((id) => CLAUDE_TOOLS.get(id) ?? id),
    ),
  ];
}
/** The one effect set whose tools are exactly `tools` (as a set), or null. Slice 1 knows `read` only. */
function effectsFor(tools: readonly string[]): string[] | null {
  const want = [...tools].sort().join(',');
  for (const effect of PROSE_EFFECT_TOOLS.keys()) if ([...toolsOf([effect])].sort().join(',') === want) return [effect];
  return null;
}
const control = (text: string): boolean => [...text].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const utf8 = (bytes: Buffer): boolean => Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes);

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const ID = /^[A-Za-z][A-Za-z0-9-]*$/;

export function lowerPlugin(inventory: PluginInventory, system: string): LoweringPlan {
  if (!NAME.test(system)) throw new HostPluginError('IA-PLUGIN-INPUT', `${system} is not a portable system name`);
  const unresolved = [...inventory.unresolved];
  const entries: Disposition[] = [];
  const files: LoweredFile[] = [];
  const assets: { path: string; role: AssetRole }[] = [];
  const resources: { path: string; bytes: Buffer; owner: string; role: string; delivery: string }[] = [];
  const lines: string[] = ['#! ia 1.0', ''];
  const records: LoweredRecord[] = [];
  const recordsPath = RECORDS_PATH(system);
  const put = (d: Omit<Disposition, 'reason'> & { reason?: string }): void => {
    entries.push(Object.freeze({ ...d, reason: d.reason ?? null }));
  };
  const text = (value: string, where: string): string => {
    if (value.includes('"') || value.includes('\\') || control(value))
      unresolved.push(`${where}: text with a double quote, backslash or control character is lowered from slice 2`);
    return `"${value}"`;
  };
  const string = (field: FrontField | undefined): string | undefined =>
    field?.value.kind === 'string' ? field.value.text : undefined;
  const field = (fields: readonly FrontField[], key: string): FrontField | undefined =>
    fields.find((candidate) => candidate.key === key);
  /** A value that, when present, must be a string; a present value of another kind is unresolved. */
  const expectString = (value: unknown, where: string, key: string): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value === 'string') return value;
    unresolved.push(`${where}: ${key} must be a string in slice 1`);
    return undefined;
  };
  const frontString = (fields: readonly FrontField[], key: string, where: string): string | undefined => {
    const found = field(fields, key);
    if (found === undefined) return undefined;
    if (found.value.kind === 'string') return found.value.text;
    unresolved.push(`${where}: ${key} must be a string in slice 1`);
    return undefined;
  };
  const frontId = (fields: readonly FrontField[], key: string, where: string): string | undefined => {
    const value = frontString(fields, key, where);
    if (value !== undefined && !ID.test(value)) {
      unresolved.push(`${where}: ${key} "${value}" is not an IA id`);
      return undefined;
    }
    return value;
  };
  /** Text a resource or asset may carry byte for byte: UTF-8, no byte-order mark, no carriage return. */
  const textProblem = (bytes: Buffer): string | null =>
    !utf8(bytes)
      ? 'not UTF-8'
      : bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
        ? 'has a byte-order mark'
        : bytes.includes(0x0d)
          ? 'has CR line endings'
          : null;

  // The product, from the manifests. Claude's is required; Codex's and Grok's must agree with it.
  const claude = inventory.manifests.claude;
  const name = typeof claude?.['name'] === 'string' ? claude['name'] : null;
  if (claude === undefined || name === null || !NAME.test(name)) {
    unresolved.push(`${MANIFESTS.claude}: missing, or without a portable name`);
    return finish();
  }
  const CLAUDE_KEYS = ['name', 'displayName', 'version', 'description', 'author', 'license', 'keywords'];
  for (const key of Object.keys(claude))
    if (!CLAUDE_KEYS.includes(key)) unresolved.push(`${MANIFESTS.claude}: key ${key} is lowered from slice 2`);
  const rawAuthor = claude['author'];
  let authorName: string | undefined;
  if (rawAuthor !== undefined) {
    const shape = rawAuthor as { name?: unknown } | null;
    if (
      typeof shape !== 'object' ||
      shape === null ||
      Array.isArray(shape) ||
      Object.keys(shape).join() !== 'name' ||
      typeof shape.name !== 'string'
    )
      unresolved.push(`${MANIFESTS.claude}: author must be {"name": string}`);
    else authorName = shape.name;
  }
  const codex = inventory.manifests.codex;
  if (codex !== undefined) {
    const CODEX_KEYS = [
      'name',
      'version',
      'description',
      'author',
      'license',
      'keywords',
      'skills',
      'hooks',
      'interface',
    ];
    for (const key of Object.keys(codex))
      if (!CODEX_KEYS.includes(key)) unresolved.push(`${MANIFESTS.codex}: key ${key} is lowered from slice 2`);
    for (const key of ['name', 'version', 'description', 'author', 'license', 'keywords'])
      if (JSON.stringify(codex[key]) !== JSON.stringify(claude[key]))
        unresolved.push(`${MANIFESTS.codex}: ${key} differs from the Claude manifest`);
    if (codex['skills'] !== './skills/') unresolved.push(`${MANIFESTS.codex}: skills must be "./skills/"`);
    if (codex['hooks'] !== undefined && JSON.stringify(codex['hooks']) !== '{"hooks":{}}')
      unresolved.push(`${MANIFESTS.codex}: hooks other than {"hooks":{}} are lowered from slice 3`);
    if (
      codex['interface'] !== undefined &&
      (typeof codex['interface'] !== 'object' || codex['interface'] === null || Array.isArray(codex['interface']))
    )
      unresolved.push(`${MANIFESTS.codex}: interface must be an object`);
    const codexFace = (
      typeof codex['interface'] === 'object' && codex['interface'] !== null ? codex['interface'] : {}
    ) as Record<string, unknown>;
    for (const key of Object.keys(codexFace))
      if (!['displayName', 'shortDescription', 'category'].includes(key))
        unresolved.push(`${MANIFESTS.codex}: interface.${key} is lowered from slice 2`);
    if (codexFace['displayName'] !== undefined && codexFace['displayName'] !== claude['displayName'])
      unresolved.push(`${MANIFESTS.codex}: interface.displayName differs from the Claude displayName`);
  }
  const grok = inventory.manifests.grok;
  if (grok !== undefined && JSON.stringify(grok) !== JSON.stringify(claude))
    unresolved.push(`${MANIFESTS.grok}: differs from the Claude manifest`);
  const face = (
    typeof codex?.['interface'] === 'object' && codex['interface'] !== null ? codex['interface'] : {}
  ) as Record<string, unknown>;
  const hosts = HOST_ORDER.filter((host) => inventory.manifests[host] !== undefined);
  let keywords: string[] | null = null;
  if (claude['keywords'] !== undefined) {
    const raw = claude['keywords'];
    if (Array.isArray(raw) && raw.every((k): k is string => typeof k === 'string')) keywords = raw;
    else unresolved.push(`${MANIFESTS.claude}: keywords must be a list of strings`);
  }
  const displayName = expectString(claude['displayName'], MANIFESTS.claude, 'displayName');
  const version = expectString(claude['version'], MANIFESTS.claude, 'version');
  const description = expectString(claude['description'], MANIFESTS.claude, 'description');
  const license = expectString(claude['license'], MANIFESTS.claude, 'license');
  const shortDescription = expectString(face['shortDescription'], MANIFESTS.codex, 'interface.shortDescription');
  const category = expectString(face['category'], MANIFESTS.codex, 'interface.category');

  lines.push(
    `@distribution ${system}-distribution`,
    '  meaning',
    `    says ${text(description ?? name, `${MANIFESTS.claude} description`)}`,
    `    answers "Which records does the ${name} plugin ship?"`,
    '  distribution',
    `    records [@system ${system}]`,
    '  product',
    `    name ${name}`,
  );
  const productText = (key: string, value: string | undefined, source: string): void => {
    if (value === undefined) return;
    lines.push(`    ${key} ${text(value, `${source} ${key}`)}`);
  };
  productText('display-name', displayName, MANIFESTS.claude);
  productText('version', version, MANIFESTS.claude);
  productText('description', description, MANIFESTS.claude);
  productText('author', authorName, MANIFESTS.claude);
  productText('license', license, MANIFESTS.claude);
  if (keywords !== null)
    lines.push(`    keywords [${keywords.map((k) => text(k, `${MANIFESTS.claude} keywords`)).join(', ')}]`);
  lines.push(`    hosts [${hosts.join(', ')}]`);
  productText('short-description', shortDescription, MANIFESTS.codex);
  productText('category', category, MANIFESTS.codex);
  lines.push('');
  records.push({ word: 'distribution', name: `${system}-distribution`, path: recordsPath });
  for (const host of hosts)
    put({
      source: MANIFESTS[host],
      key: null,
      kind: 'derived',
      target: `@distribution ${system}-distribution product`,
    });

  // Skills: one capability each, the body as an inline resource, owned Markdown as installed references.
  const capabilityNames = new Set<string>();
  const agentNames = new Set<string>([system, `${system}-steward`]);
  for (const skill of inventory.skills) {
    const where = skill.file.path;
    unresolved.push(...skill.frontmatter.unresolved);
    if (capabilityNames.has(skill.name))
      unresolved.push(`${where}: the name ${skill.name} collides with another record`);
    capabilityNames.add(skill.name);
    const fields = skill.frontmatter.fields;
    for (const f of fields)
      if (!['name', 'description', 'disable-model-invocation', 'argument-hint'].includes(f.key))
        unresolved.push(`${where}: frontmatter key ${f.key} is lowered from slice 2`);
    if (string(field(fields, 'name')) !== skill.name) unresolved.push(`${where}: name must equal the folder name`);
    const skillDescription = frontString(fields, 'description', where);
    if (field(fields, 'description') === undefined) unresolved.push(`${where}: no description`);
    const disabled = field(fields, 'disable-model-invocation')?.value;
    if (disabled !== undefined && disabled.kind !== 'boolean')
      unresolved.push(`${where}: disable-model-invocation must be a boolean in slice 1`);
    const hint = frontString(fields, 'argument-hint', where);
    lines.push(
      `@capability ${skill.name}`,
      '  meaning',
      `    says ${text(skillDescription ?? '', `${where} description`)}`,
      `    answers "Lowered from ${where}."`,
      '  execution',
      '    effects []',
      '  invocation',
      `    mode ${disabled?.kind === 'boolean' && disabled.value ? 'user' : 'model'}`,
      ...(hint === undefined ? [] : [`    argument-hint ${text(hint, `${where} argument-hint`)}`]),
      '',
    );
    records.push({ word: 'capability', name: skill.name, path: recordsPath });
    put({ source: where, key: 'name', kind: 'derived', target: `@capability ${skill.name}` });
    put({ source: where, key: 'description', kind: 'field', target: `@capability ${skill.name} meaning.says` });
    if (disabled?.kind === 'boolean')
      put({
        source: where,
        key: 'disable-model-invocation',
        kind: 'field',
        target: `@capability ${skill.name} invocation.mode`,
      });
    if (hint !== undefined)
      put({
        source: where,
        key: 'argument-hint',
        kind: 'field',
        target: `@capability ${skill.name} invocation.argument-hint`,
      });
    const bodyPath = `${RESOURCE_ROOT(system)}/skills/${skill.name}/SKILL.body.md`;
    resources.push({
      path: bodyPath,
      bytes: skill.frontmatter.body,
      owner: IDENTITY.capability(skill.name),
      role: 'body',
      delivery: 'inline',
    });
    put({ source: where, key: null, kind: 'resource', target: bodyPath });
    for (const owned of skill.owned) lowerOwned(owned, IDENTITY.capability(skill.name), skill.name);
  }

  // Agents: an @agent, a tools capability and an @agent-profile each; the prompt as an inline resource.
  for (const agent of inventory.agents) {
    const where = agent.file.path;
    unresolved.push(...agent.frontmatter.unresolved);
    if (agentNames.has(agent.name)) unresolved.push(`${where}: the name ${agent.name} collides with another record`);
    agentNames.add(agent.name);
    if (capabilityNames.has(`${agent.name}-tools`))
      unresolved.push(`${where}: the name ${agent.name}-tools collides with another record`);
    capabilityNames.add(`${agent.name}-tools`);
    const fields = agent.frontmatter.fields;
    for (const f of fields)
      if (!['name', 'description', 'tools', 'model', 'color', 'effort'].includes(f.key))
        unresolved.push(`${where}: frontmatter key ${f.key} is lowered from slice 2`);
    if (string(field(fields, 'name')) !== agent.name) unresolved.push(`${where}: name must equal the file name`);
    const agentDescription = frontString(fields, 'description', where) ?? '';
    if (field(fields, 'description') === undefined) unresolved.push(`${where}: no description`);
    const toolsValue: FrontValue | undefined = field(fields, 'tools')?.value;
    if (toolsValue?.kind === 'boolean') unresolved.push(`${where}: tools must be a string or a list in slice 1`);
    const tools =
      toolsValue?.kind === 'string'
        ? toolsValue.text.split(',').map((t) => t.trim())
        : toolsValue?.kind === 'list'
          ? [...toolsValue.items]
          : [];
    const effects = effectsFor(tools);
    if (effects === null) unresolved.push(`${where}: tools ${tools.join(', ') || '(none)'} match no effect yet`);
    const optional = (key: string, line: (value: string) => string): string[] => {
      const value = frontId(fields, key, where);
      return value === undefined ? [] : [line(value)];
    };
    const color = frontId(fields, 'color', where);
    lines.push(
      `@agent ${agent.name}`,
      '  meaning',
      `    says ${text(agentDescription, `${where} description`)}`,
      `    answers "Lowered from ${where}."`,
      '  governance',
      '    applies []',
      '',
      `@capability ${agent.name}-tools`,
      '  meaning',
      `    says "The host tools the ${agent.name} agent may use."`,
      `    answers "Which effects does the ${agent.name} agent need?"`,
      '  execution',
      `    effects [${(effects ?? []).join(', ')}]`,
      '',
      `@agent-profile ${agent.name}`,
      '  meaning',
      `    says ${text(agentDescription, `${where} description`)}`,
      `    answers "Lowered from ${where}."`,
      '  composition',
      `    agent @agent ${agent.name}`,
      `    capabilities [@capability ${agent.name}-tools]`,
      '  execution',
      `    role ${agent.name}`,
      '    outcomes report-v1',
      '    mandate-contract plugin-v1',
      ...optional('model', (v) => `    model-profile ${v}`),
      ...optional('effort', (v) => `    effort ${v}`),
      '  invocation',
      '    mode model',
      ...(color === undefined ? [] : ['  presentation', `    color ${color}`]),
      '',
    );
    records.push(
      { word: 'agent', name: agent.name, path: recordsPath },
      { word: 'capability', name: `${agent.name}-tools`, path: recordsPath },
      { word: 'agent-profile', name: agent.name, path: recordsPath },
    );
    put({ source: where, key: 'description', kind: 'field', target: `@agent-profile ${agent.name} meaning.says` });
    put({ source: where, key: 'tools', kind: 'field', target: `@capability ${agent.name}-tools execution.effects` });
    const bodyPath = `${RESOURCE_ROOT(system)}/agents/${agent.name}.body.md`;
    resources.push({
      path: bodyPath,
      bytes: agent.frontmatter.body,
      owner: IDENTITY.profile(agent.name),
      role: 'body',
      delivery: 'inline',
    });
    put({ source: where, key: null, kind: 'resource', target: bodyPath });
  }

  for (const other of inventory.other) asset(other);
  return finish();

  function lowerOwned(entry: PluginEntry, owner: string, skill: string): void {
    if (!entry.path.endsWith('.md')) return asset(entry);
    const inside = entry.path.slice(`skills/${skill}/`.length);
    const role = inside.startsWith('references/')
      ? 'guide'
      : inside.startsWith('templates/') || inside.startsWith('assets/templates/')
        ? 'template'
        : inside.startsWith('examples/')
          ? 'example'
          : 'support';
    const path = `${RESOURCE_ROOT(system)}/${entry.path}`;
    const problem = textProblem(entry.bytes);
    if (problem !== null) unresolved.push(`${entry.path}: ${problem}`);
    resources.push({ path, bytes: entry.bytes, owner, role, delivery: 'installed-reference' });
    put({ source: entry.path, key: null, kind: 'resource', target: path });
  }
  function asset(entry: PluginEntry): void {
    const problem = textProblem(entry.bytes);
    if (problem === 'not UTF-8') unresolved.push(`${entry.path}: binary assets are lowered from slice 2`);
    else if (problem !== null) unresolved.push(`${entry.path}: ${problem}`);
    const path = `${ASSET_ROOT}/${entry.path}`;
    const base = entry.path.split('/').pop()!;
    const role: AssetRole = /^(?:LICENSE|LICENCE|COPYING)(?:\..*)?$/.test(base)
      ? 'license'
      : base.endsWith('.md')
        ? 'documentation'
        : 'asset';
    files.push({ path, bytes: entry.bytes });
    assets.push({ path, role });
    put({ source: entry.path, key: null, kind: 'asset', target: path });
  }
  function finish(): LoweringPlan {
    const seen = new Set<string>();
    for (const out of [
      ...files.map((f) => f.path),
      ...resources.map((r) => r.path),
      recordsPath,
      SYSTEM_PATH(system),
      '.ia/authoring.resources.json',
      'assets/MIGRATION.md',
      'assets/lowering-map.json',
    ]) {
      if (seen.has(out)) unresolved.push(`${out}: two lowered files share this output path`);
      seen.add(out);
    }
    for (const reason of unresolved)
      put({ source: reason.split(':')[0]!, key: null, kind: 'unresolved', target: '', reason });
    const sortedEntries = [...entries].sort((a, b) =>
      a.source === b.source ? cmp(a.key ?? '', b.key ?? '') : cmp(a.source, b.source),
    );
    const map: LoweringMap = Object.freeze({
      format: 'ia.lowering-map.v1',
      plugin: name ?? '',
      system,
      entries: Object.freeze(sortedEntries),
    });
    const mapBytes = Buffer.from(`${JSON.stringify(map, null, 2)}\n`);
    const migration = Buffer.from(
      [
        `# Migration map: ${name ?? ''} to ${system}`,
        '',
        'Generated by ia init --from from assets/lowering-map.json; edit the records, not this file.',
        '',
        '| Source | Key | Disposition | Target |',
        '| --- | --- | --- | --- |',
        ...sortedEntries.map(
          (e) =>
            `| \`${e.source}\` | ${e.key ?? ''} | ${e.kind} | ${e.target ? `\`${e.target}\`` : (e.reason ?? '')} |`,
        ),
        '',
      ].join('\n'),
    );
    const owners = new Map<string, { path: string; role: string; delivery: string }[]>();
    for (const r of resources) owners.set(r.owner, [...(owners.get(r.owner) ?? []), r]);
    const manifest = {
      format: 'ia.authoring-resources.v1',
      files: [...resources]
        .sort((a, b) => cmp(a.path, b.path))
        .map((r) => ({
          path: r.path,
          bytes: r.bytes.length,
          sha256: sha(r.bytes),
          mediaType: 'text/markdown',
          encoding: 'utf8',
        })),
      associations: [...owners.entries()]
        .sort(([a], [b]) => cmp(a, b))
        .map(([owner, uses]) => {
          const order = new Map<string, number>();
          return {
            owner: { source: 'self', path: recordsPath, identity: owner },
            resources: [...uses]
              .sort((a, b) => (a.role === b.role ? cmp(a.path, b.path) : cmp(a.role, b.role)))
              .map((use) => {
                const next = order.get(use.role) ?? 0;
                order.set(use.role, next + 1);
                return {
                  key: { source: 'self', path: use.path },
                  role: use.role,
                  order: next,
                  required: true,
                  delivery: use.delivery,
                };
              }),
          };
        }),
      index: { systems: [], artifacts: [], profiles: [], documents: [], lifecycles: [] },
    };
    const systemText = [
      '#! ia 1.0',
      '',
      `@system ${system}`,
      '  provider "local"',
      '  version "0.1.0"',
      `  describes "The ${name ?? system} plugin, lowered into records by ia init --from."`,
      `  steward @agent ${system}-steward`,
      '  requires',
      '    - agent-system',
      '    - agent-composition-system',
      '    - workspace-system',
      '',
      `@agent ${system}-steward`,
      '  meaning',
      `    says "Owns the ${system} system and its lowered records."`,
      '    answers "Who owns this system?"',
      '  governance',
      '    applies [capability, agent, agent-profile, distribution]',
      '',
    ].join('\n');
    const all: LoweredFile[] = [
      ...files,
      { path: '.ia/authoring.resources.json', bytes: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
      ...resources.map((r) => ({ path: r.path, bytes: r.bytes })),
      { path: recordsPath, bytes: Buffer.from(lines.join('\n')) },
      { path: SYSTEM_PATH(system), bytes: Buffer.from(systemText) },
      { path: 'assets/MIGRATION.md', bytes: migration },
      { path: 'assets/lowering-map.json', bytes: mapBytes },
    ].sort((a, b) => cmp(a.path, b.path));
    const allAssets = [
      ...assets,
      { path: 'assets/MIGRATION.md', role: 'documentation' as const },
      { path: 'assets/lowering-map.json', role: 'asset' as const },
    ].sort((a, b) => cmp(a.path, b.path));
    return Object.freeze({
      system,
      files: Object.freeze(all.map((f) => Object.freeze(f))),
      records: Object.freeze([
        { word: 'system', name: system, path: SYSTEM_PATH(system) },
        { word: 'agent', name: `${system}-steward`, path: SYSTEM_PATH(system) },
        ...records,
      ]),
      assets: Object.freeze(allAssets),
      map,
      unresolved: Object.freeze([...unresolved]),
    });
  }
}
