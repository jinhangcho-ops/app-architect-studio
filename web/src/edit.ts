// 화면의 편집 동작을 순수 함수로 둔다(store와 테스트가 같이 씀). 모두 새 Project를 돌려준다.
import { analyze, type Analysis } from '../../engine/analyze';
import { parseProject } from '../../engine/data';
import type { NodeJudgement } from '../../engine/judge';
import { LAYER_NAMES, VERDICT_RANK, type Layer, type Verdict } from '../../engine/model';
import { optimize, withAssignment, type OptimizeResult } from '../../engine/optimize';
import { INDUSTRIES, mixShares, type IndustryId, type MixPeak } from '../../engine/industry';
import { traffic, type Traffic } from '../../engine/traffic';
import { EdgeSchema, NodeSchema, nodeStorageProfile, selectedFeatures, Table as TableSchema, withPrimary, type Project, type ProjectEdge, type ProjectNode, type Screen, type WireItem } from '../../engine/schema';
import { catalog, engineData } from './data';

export type RunResult = { analysis?: Analysis; error?: string };

/** 트래픽(시드 고정 무작위 하루)이 읽는 값 전부. 이것들이 그대로면 트래픽도 같다 (편집은 바뀐 곳만 새 객체). 하루 곡선 그래프도 이것으로 다시 계산할지 정한다 */
export const trafficKey = (p: Project) => [p.personas, p.scale, p.deploy, p.actions, p.exchange];

// 이름·항목·연결만 바꾼 편집은 트래픽을 다시 돌리지 않는다
let lastTraffic: { key: unknown[]; traffic: Traffic | undefined } | undefined;
function trafficOf(p: Project, parsed: Project) {
  const key = trafficKey(p), prev = lastTraffic;
  if (prev && key.every((k, i) => k === prev.key[i])) return prev.traffic;
  // 페르소나 이름만 바꿨으면(입력 칸에 한 글자씩) 숫자는 같다: 다시 돌리지 않고 이름만 바꿔 붙인다.
  // 트래픽 결과의 페르소나는 인원이 0명인 페르소나를 뺀 순서 (traffic()과 같은 조건)
  const before = prev?.key[0] as Project['personas'] | undefined;
  if (prev?.traffic && before && key.every((k, i) => i === 0 || k === prev.key[i]) && before.length === p.personas.length
    && p.personas.every((ps, i) => ps === before[i] || JSON.stringify({ ...ps, name: '' }) === JSON.stringify({ ...before[i], name: '' }))) {
    const names = parsed.personas.filter((ps) => Math.round(parsed.scale!.users * ps.share) > 0).map((ps) => ps.name);
    lastTraffic = { key, traffic: { ...prev.traffic, personas: prev.traffic.personas.map((x, i) => ({ ...x, name: names[i] })) } };
  } else lastTraffic = { key, traffic: traffic(parsed) };
  return lastTraffic.traffic;
}

/** 입력이 틀렸으면 계산하지 않고 무엇이 틀렸는지 돌려준다. */
export function run(p: Project, today: string): RunResult {
  try {
    const parsed = parseProject(p, catalog.items);
    return { analysis: analyze(parsed, engineData, today, { traffic: trafficOf(p, parsed) }) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** 최선 조합 찾기. 조합마다 분석하므로 버튼을 눌렀을 때만 부른다. */
export function findPlans(p: Project, today: string): { result?: OptimizeResult; error?: string } {
  try {
    const parsed = parseProject(p, catalog.items);
    return { result: optimize(parsed, engineData, today, { traffic: trafficOf(p, parsed) }) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export const applyPlan = withAssignment;

/** 주 항목이 바뀌면 이전 시스템의 저장 기능 선택을 지운다 (withPrimary) */
export const updateNode = (p: Project, id: string, patch: Partial<ProjectNode>): Project =>
  ({ ...p, nodes: p.nodes.map((n) => (n.id !== id ? n : { ...('primary' in patch ? withPrimary(n, patch.primary) : n), ...patch })) });

/** 노드를 지우면 연결선과, 그 노드의 테이블에 쓰는 행동 줄도 지운다 (쓸 곳이 없어진 행동과 그 빈도도). 와이어프레임 호출의 대상도 비운다 */
export const removeNode = (p: Project, id: string): Project => {
  const n = p.nodes.find((x) => x.id === id);
  const cleared = (n?.tables ?? []).reduce((acc, t) => removeTable(acc, id, t.name), p);
  const unbind = (x: ProjectNode): ProjectNode => (!x.wireframe ? x : {
    ...x, wireframe: { screens: x.wireframe.screens.map((s) => ({ ...s, items: s.items.map((i) => (i.api?.to === id ? { ...i, api: { ...i.api, to: undefined } } : i)) })) },
  });
  return { ...cleared, nodes: cleared.nodes.filter((x) => x.id !== id).map(unbind), edges: cleared.edges.filter((e) => e.from !== id && e.to !== id) };
};

/** 목록의 i번째만 바꾼 새 목록 */
export const patchAt = <T,>(xs: T[], i: number, patch: Partial<T>): T[] => xs.map((x, k) => (k === i ? { ...x, ...patch } : x));

/** make(k)가 taken에 없는 가장 작은 k (from부터) */
const freeK = (taken: string[], make: (k: number) => string, from = 1) => {
  let k = from;
  while (taken.includes(make(k))) k++;
  return k;
};

export function addNode(p: Project, layer: Layer): { project: Project; id: string } {
  const k = freeK(p.nodes.map((n) => n.id), (k) => `${layer}-${k}`);
  const id = `${layer}-${k}`;
  return { project: { ...p, nodes: [...p.nodes, NodeSchema.parse({ id, name: `${LAYER_NAMES[layer]} ${k}`, layer })] }, id };
}

const sameEdge = (e: ProjectEdge, from: string, to: string) => e.from === from && e.to === to;

export const addEdge = (p: Project, from: string, to: string): Project =>
  from === to || p.edges.some((e) => sameEdge(e, from, to)) ? p : { ...p, edges: [...p.edges, EdgeSchema.parse({ from, to })] };

export const updateEdge = (p: Project, from: string, to: string, patch: Partial<ProjectEdge>): Project =>
  ({ ...p, edges: p.edges.map((e) => (sameEdge(e, from, to) ? { ...e, ...patch } : e)) });

export const removeEdge = (p: Project, from: string, to: string): Project =>
  ({ ...p, edges: p.edges.filter((e) => !sameEdge(e, from, to)) });

/** 판정 화면의 대안 '적용': 주 항목이면 주 항목을, 보조 항목이면 그 자리를 바꾼다. */
export function applyAlternative(p: Project, nodeId: string, fromItem: string, toItem: string): Project {
  const n = p.nodes.find((x) => x.id === nodeId)!;
  if (n.primary === fromItem) return updateNode(p, nodeId, { primary: toItem });
  return updateNode(p, nodeId, { extras: [...new Set(n.extras.map((x) => (x === fromItem ? toItem : x)))] });
}

/** 노드에 직접 넣는 판정 변수(평소·이벤트 같은 값). value가 undefined면 지운다. */
export function setVar(p: Project, nodeId: string, key: string, value: number | boolean | string | undefined): Project {
  const n = p.nodes.find((x) => x.id === nodeId)!;
  const put = (vars: Record<string, number | boolean | string>) => {
    const next = { ...vars };
    if (value === undefined) delete next[key];
    else next[key] = value;
    return next;
  };
  return updateNode(p, nodeId, { vars: { normal: put(n.vars.normal), event: put(n.vars.event) } });
}

/** 노드 배지: 붙은 항목 중 가장 나쁜 판정 */
export const worstVerdict = (j?: NodeJudgement): Verdict | undefined =>
  j?.items.reduce<Verdict | undefined>((w, i) => (!w || VERDICT_RANK[i.verdict] > VERDICT_RANK[w] ? i.verdict : w), undefined);

// ── 테이블 ──
type Table = ProjectNode['tables'][number];
type Action = Project['actions'][number];

const mapTables = (p: Project, nodeId: string, fn: (ts: Table[]) => Table[]): Project =>
  ({ ...p, nodes: p.nodes.map((n) => (n.id === nodeId ? { ...n, tables: fn(n.tables) } : n)) });

/** 명세서에 없는 데이터 사전 메타(테이블 논리명·설명·장 형식, 같은 이름 컬럼의 논리명·도메인·코드·개인정보·기본값·설명)는 옛 값을 쓴다.
 *  shortcut: personal·record는 기본값(false·variable)이면 옛 값을 쓰므로 JSON 명세로 끄거나 가변장으로 되돌릴 수는 없다 — 필요하면 칸에서 바꾼다 */
function keepMeta(t: Table, old: Table): Table {
  return {
    ...t,
    label: t.label ?? old.label,
    description: t.description ?? old.description,
    record: t.record === 'variable' ? old.record : t.record,
    columns: t.columns.map((c) => {
      const o = old.columns.find((x) => x.name === c.name);
      return !o ? c : {
        ...c,
        label: c.label ?? o.label, domain: c.domain ?? o.domain, codes: c.codes ?? o.codes,
        personal: c.personal || o.personal, default_value: c.default_value ?? o.default_value, description: c.description ?? o.description,
      };
    }),
  };
}

/** 명세서로 읽은 테이블을 노드에 넣는다. 이름이 같은 테이블은 바꾸고(명세서에 없는 메타는 옛 값 유지) 나머지는 뒤에 붙인다 */
export function importTables(p: Project, nodeId: string, tables: Table[]): { project: Project; replaced: string[] } {
  const n = p.nodes.find((x) => x.id === nodeId)!;
  const replaced = tables.filter((t) => n.tables.some((x) => x.name === t.name)).map((t) => t.name);
  const project = mapTables(p, nodeId, (ts) => [
    ...ts.map((x) => { const t = tables.find((y) => y.name === x.name); return t ? keepMeta(t, x) : x; }),
    ...tables.filter((t) => !ts.some((x) => x.name === t.name)),
  ]);
  return { project, replaced };
}

/** 테이블 고치기. 이름이 바뀌면 그 테이블을 가리키는 행동도 같이 고친다 */
export function updateTable(p: Project, nodeId: string, name: string, patch: Partial<Table>): Project {
  const next = mapTables(p, nodeId, (ts) => ts.map((t) => (t.name === name ? { ...t, ...patch } : t)));
  if (patch.name === undefined || patch.name === name) return next;
  const rename = <T extends { node: string; table: string }>(w: T): T => (w.node === nodeId && w.table === name ? { ...w, table: patch.name! } : w);
  return {
    ...next,
    actions: next.actions.map((a) => ({ ...a, writes: a.writes.map(rename) })),
    edges: next.edges.map((e) => ({ ...e, interfaces: e.interfaces.map((i) => (i.tables ? { ...i, tables: i.tables.map(rename) } : i)) })),
  };
}

/** 테이블을 지우면 그 테이블에 쓰는 행동 줄도 지우고, 쓸 곳이 없어진 행동은 없앤다 */
export function removeTable(p: Project, nodeId: string, name: string): Project {
  const next = mapTables(p, nodeId, (ts) => ts.filter((t) => t.name !== name));
  const actions = next.actions
    .map((a) => ({ ...a, writes: a.writes.filter((w) => !(w.node === nodeId && w.table === name)) }))
    .filter((a) => a.writes.length > 0);
  const gone = next.actions.filter((a) => !actions.some((x) => x.name === a.name)).map((a) => a.name);
  const edges = next.edges.map((e) => ({ ...e, interfaces: e.interfaces.map((i) => {
    const tables = i.tables?.filter((t) => !(t.node === nodeId && t.table === name));
    return i.tables ? { ...i, tables: tables!.length ? tables : undefined } : i;
  }) }));
  return dropRates({ ...next, actions, edges }, gone);
}

export function addTable(p: Project, nodeId: string): Project {
  const n = p.nodes.find((x) => x.id === nodeId)!;
  const k = freeK(n.tables.map((t) => t.name), (k) => `table_${k}`);
  return mapTables(p, nodeId, (ts) => [...ts, TableSchema.parse({ name: `table_${k}`, columns: [{ name: 'id', type: 'bigint' }], primary_key: ['id'] })]);
}

/** 컬럼 이름 바꾸기: 같은 테이블의 기본 키·인덱스·파티션도 새 이름으로. 이미 있는 이름이면 undefined (저장하지 않음) */
export function renameColumn(t: Table, from: string, to: string): Table | undefined {
  if (t.columns.some((c) => c.name === to)) return undefined;
  const ren = (x: string) => (x === from ? to : x);
  return {
    ...t,
    columns: t.columns.map((c) => (c.name === from ? { ...c, name: to } : c)),
    primary_key: t.primary_key.map(ren),
    indexes: t.indexes.map((i) => ({ ...i, columns: i.columns.map(ren) })),
    partition: t.partition && { ...t.partition, column: ren(t.partition.column) },
  };
}

/** i번째 컬럼 지우기: 기본 키·인덱스에서 빼고, 컬럼이 없어진 인덱스와 그 컬럼의 파티션은 지운다 */
export function removeColumn(t: Table, i: number): Table {
  const name = t.columns[i].name;
  const keep = (x: string) => x !== name;
  return {
    ...t,
    columns: t.columns.filter((_, k) => k !== i),
    primary_key: t.primary_key.filter(keep),
    indexes: t.indexes.map((x) => ({ ...x, columns: x.columns.filter(keep) })).filter((x) => x.columns.length),
    partition: t.partition?.column === name ? undefined : t.partition,
  };
}

// ── 행동 ──
const dropRates = (p: Project, names: string[]): Project => (!names.length ? p : {
  ...p,
  personas: p.personas.map((ps) => ({ ...ps, action_rates: Object.fromEntries(Object.entries(ps.action_rates).filter(([k]) => !names.includes(k))) })),
});

export function addAction(p: Project): Project {
  const first = p.nodes.flatMap((n) => n.tables.map((t) => ({ node: n.id, table: t.name, rows: 1 })))[0];
  if (!first) return p;
  const k = freeK(p.actions.map((a) => a.name), (k) => `행동 ${k}`);
  return { ...p, actions: [...p.actions, { name: `행동 ${k}`, per_session: 0.1, writes: [first] }] };
}

/** 행동 고치기. 이름이 바뀌면 페르소나별 빈도의 이름도 바꾼다 */
export function updateAction(p: Project, name: string, patch: Partial<Action>): Project {
  const next = { ...p, actions: p.actions.map((a) => (a.name === name ? { ...a, ...patch } : a)) };
  if (patch.name === undefined || patch.name === name) return next;
  return {
    ...next,
    personas: next.personas.map((ps) => ({
      ...ps, action_rates: Object.fromEntries(Object.entries(ps.action_rates).map(([k, v]) => [k === name ? patch.name! : k, v])),
    })),
  };
}

export const removeAction = (p: Project, name: string): Project =>
  dropRates({ ...p, actions: p.actions.filter((a) => a.name !== name) }, [name]);

/** 페르소나 하나의 행동 빈도. undefined면 행동의 기본 빈도를 쓴다 */
export function setActionRate(p: Project, persona: number, action: string, value: number | undefined): Project {
  return {
    ...p,
    personas: p.personas.map((ps, i) => {
      if (i !== persona) return ps;
      const rates = { ...ps.action_rates };
      if (value === undefined) delete rates[action];
      else rates[action] = value;
      return { ...ps, action_rates: rates };
    }),
  };
}

/** 행동이 이 테이블에 쓰게 한다 (이미 쓰면 그대로) */
export function addWrite(p: Project, action: string, node: string, table: string): Project {
  const a = p.actions.find((x) => x.name === action);
  if (!a || a.writes.some((w) => w.node === node && w.table === table)) return p;
  return updateAction(p, action, { writes: [...a.writes, { node, table, rows: 1 }] });
}

/** 행동의 쓰기 하나를 뺀다. 쓸 곳이 하나도 남지 않으면 행동을 지운다 */
export function removeWrite(p: Project, action: string, node: string, table: string): Project {
  const a = p.actions.find((x) => x.name === action);
  if (!a) return p;
  const writes = a.writes.filter((w) => !(w.node === node && w.table === table));
  return writes.length ? updateAction(p, action, { writes }) : removeAction(p, action);
}

/** 붙여넣기(Ctrl+V): 복사한 노드를 새 id·"(복사)" 이름으로 넣는다. 연결선과 행동은 따라오지 않는다 */
export function pasteNode(p: Project, node: ProjectNode): { project: Project; id: string } {
  const k = freeK(p.nodes.map((n) => n.id), (k) => `${node.id}-${k}`, 2);
  const id = `${node.id}-${k}`;
  return { project: { ...p, nodes: [...p.nodes, { ...node, id, name: `${node.name} (복사)` }] }, id };
}

// ── 세부 구성의 끌어 놓기 ──
/** 왼편 목록에서 끌어 온 것 / 다이어그램에서 왼편으로 끌어 낸 것 */
export type Drag =
  | { kind: 'item'; id: string }
  | { kind: 'table' }
  | { kind: 'action' }
  | { kind: 'feature'; id: string }
  | { kind: 'ui'; ui: WireItem['kind'] }
  | { kind: 'remove'; what: 'extra' | 'feature' | 'table'; id: string }
  | { kind: 'remove'; what: 'wire'; screen: number; id: string };

/** 주 항목을 놓으면 교체, 보조 항목을 놓으면 추가 */
export function dropItem(p: Project, nodeId: string, itemId: string): Project {
  const n = p.nodes.find((x) => x.id === nodeId)!;
  const it = catalog.byId.get(itemId);
  if (!it || !it.attaches_to.includes(n.layer)) return p;
  if (it.role === '주') return updateNode(p, nodeId, { primary: itemId });
  return n.extras.includes(itemId) ? p : updateNode(p, nodeId, { extras: [...n.extras, itemId] });
}

/** 저장 기능 켜기·끄기. 처음 고르면 권장 기능에서 시작하고, 하나만 고르는 묶음은 같은 묶음의 다른 기능을 끈다 */
export function setFeature(p: Project, nodeId: string, featureId: string, on: boolean): Project {
  const n = p.nodes.find((x) => x.id === nodeId)!;
  const sp = nodeStorageProfile(n, catalog.byId);
  const f = sp?.features.find((x) => x.id === featureId);
  if (!sp || !f) return p;
  let ids = selectedFeatures(sp, n).map((x) => x.id).filter((id) => id !== featureId);
  if (on && sp.groups[f.group]?.one) ids = ids.filter((id) => sp.features.find((x) => x.id === id)?.group !== f.group);
  return updateNode(p, nodeId, { storage_features: on ? [...ids, featureId] : ids });
}

/** 다이어그램에서 왼편으로 끌어 낸 것 빼기 */
export function dropRemove(p: Project, nodeId: string, d: Extract<Drag, { kind: 'remove' }>): Project {
  const n = p.nodes.find((x) => x.id === nodeId)!;
  if (d.what === 'extra') return updateNode(p, nodeId, { extras: n.extras.filter((e) => e !== d.id) });
  if (d.what === 'feature') return setFeature(p, nodeId, d.id, false);
  if (d.what !== 'wire') return removeTable(p, nodeId, d.id);
  return mapScreens(p, nodeId, (ss) => ss.map((s, i) => (i !== d.screen ? s : { ...s, items: s.items.filter((x) => x.id !== d.id) })));
}

// ── 와이어프레임 ──
export const screensOf = (n: ProjectNode): Screen[] => n.wireframe?.screens ?? [{ name: '화면 1', items: [] }];
export const mapScreens = (p: Project, nodeId: string, fn: (ss: Screen[]) => Screen[]): Project =>
  updateNode(p, nodeId, { wireframe: { screens: fn(screensOf(p.nodes.find((x) => x.id === nodeId)!)) } });

/** 이름이 겹치면 뒤에 번호를 붙인다 (호출 목록·설계서 표가 화면 이름으로 줄을 가른다) */
export const uniqueName = (names: string[], base: string) => {
  let name = base;
  for (let k = 2; names.includes(name); k++) name = `${base} ${k}`;
  return name;
};

/** 화면 한 장 더하기 (screen이 없으면 빈 화면, device는 그 화면의 기기) */
export function addScreen(p: Project, nodeId: string, device?: Screen['device'], screen?: Screen): Project {
  return mapScreens(p, nodeId, (ss) => {
    const add = screen ?? { name: `화면 ${freeK(ss.map((s) => s.name), (k) => `화면 ${k}`, ss.length + 1)}`, items: [] };
    return [...ss, { ...add, name: uniqueName(ss.map((s) => s.name), add.name), ...(device && { device }) }];
  });
}

export function addWire(p: Project, nodeId: string, screen: number, item: Omit<WireItem, 'id'>): Project {
  return mapScreens(p, nodeId, (ss) => ss.map((s, i) => {
    if (i !== screen) return s;
    const id = `w${freeK(s.items.map((x) => x.id), (k) => `w${k}`, s.items.length + 1)}`;
    return { ...s, items: [...s.items, { ...item, id }] };
  }));
}

export const updateWire = (p: Project, nodeId: string, screen: number, id: string, patch: Partial<WireItem>): Project =>
  mapScreens(p, nodeId, (ss) => ss.map((s, i) => (i !== screen ? s : { ...s, items: s.items.map((x) => (x.id === id ? { ...x, ...patch } : x)) })));

/** 컨트롤에 API 호출을 붙이거나 고친다. 대상이 정해지면 화면 → 대상 연결선이 없을 때 만든다 */
export function bindApi(p: Project, nodeId: string, screen: number, id: string, api: WireItem['api']): Project {
  const next = updateWire(p, nodeId, screen, id, { api });
  return api?.to ? addEdge(next, nodeId, api.to) : next;
}

// ── 페르소나 ──
/** 페르소나 고치기. 이름이 바뀌면 유입 모형의 "들어오는 페르소나"도 따라 바꾼다 */
/** 페르소나 분포를 정하면 비율도 그 분포대로 (정수 %, 합 100). 페르소나는 목록 위에서부터 활발한 순으로 본다 */
export const setPersonaMix = (p: Project, mix: MixPeak[]): Project => {
  const pct = mixShares(mix, p.personas.length);
  return { ...p, persona_mix: mix, personas: p.personas.map((ps, i) => ({ ...ps, share: pct[i] / 100 })) };
};

/** 업종 미리 설정: 하루 피크 시각과 페르소나 분포를 한 번에 바꾼다. id가 없으면 업종을 지운다 (페르소나마다 창 가운데 한 봉우리) */
export function applyIndustry(p: Project, id: IndustryId | undefined): Project {
  if (!p.scale) return p;
  const next = { ...p, scale: { ...p.scale, industry: id, day: undefined } };
  return id && p.personas.length ? setPersonaMix(next, INDUSTRIES[id].mix) : next;
}

export function updatePersona(p: Project, i: number, patch: Partial<Project['personas'][number]>): Project {
  const old = p.personas[i]?.name;
  // 비율을 손으로 바꾸면 분포 모양(persona_mix)과 맞지 않게 되므로 모양은 지운다
  const next = { ...p, personas: patchAt(p.personas, i, patch), ...(patch.share !== undefined && { persona_mix: undefined }) };
  const inflow = p.growth?.inflow;
  return patch.name !== undefined && inflow?.entry === old ? { ...next, growth: { ...p.growth!, inflow: { ...inflow, entry: patch.name } } } : next;
}

/** 페르소나 지우기. 유입 모형이 그 페르소나로 들어오게 되어 있으면 남은 첫 페르소나로, 남은 게 없으면 유입 모형을 끈다 */
export function removePersona(p: Project, i: number): Project {
  const gone = p.personas[i]?.name;
  const personas = p.personas.filter((_, k) => k !== i);
  const inflow = p.growth?.inflow;
  if (!inflow || inflow.entry !== gone) return { ...p, personas };
  if (!personas.length) { const { inflow: _, ...rest } = p.growth!; return { ...p, personas, growth: rest }; }
  return { ...p, personas, growth: { ...p.growth!, inflow: { ...inflow, entry: personas[0].name } } };
}
