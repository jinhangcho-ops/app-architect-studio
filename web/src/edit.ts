// 화면의 편집 동작을 순수 함수로 둔다(store와 테스트가 같이 씀). 모두 새 Project를 돌려준다.
import { analyze, type Analysis } from '../../engine/analyze';
import { parseProject } from '../../engine/data';
import type { NodeJudgement } from '../../engine/judge';
import { LAYER_NAMES, type Layer, type Verdict } from '../../engine/model';
import { optimize, type OptimizeResult } from '../../engine/optimize';
import { EdgeSchema, NodeSchema, Table as TableSchema, withPrimary, type Project, type ProjectEdge, type ProjectNode } from '../../engine/schema';
import { catalog, engineData } from './data';

export type RunResult = { analysis?: Analysis; error?: string };

/** 입력이 틀렸으면 계산하지 않고 무엇이 틀렸는지 돌려준다. */
export function run(p: Project, today: string): RunResult {
  try {
    return { analysis: analyze(parseProject(p, catalog.items), engineData, today) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** 최선 조합 찾기. 조합마다 분석하므로 버튼을 눌렀을 때만 부른다. */
export function findPlans(p: Project, today: string): { result?: OptimizeResult; error?: string } {
  try {
    return { result: optimize(parseProject(p, catalog.items), engineData, today) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export const applyPlan = (p: Project, assignment: Record<string, string>): Project =>
  ({ ...p, nodes: p.nodes.map((n) => (assignment[n.id] ? withPrimary(n, assignment[n.id]) : n)) });

/** 주 항목이 바뀌면 이전 시스템의 저장 기능 선택을 지운다 (withPrimary) */
export const updateNode = (p: Project, id: string, patch: Partial<ProjectNode>): Project =>
  ({ ...p, nodes: p.nodes.map((n) => (n.id !== id ? n : { ...('primary' in patch ? withPrimary(n, patch.primary) : n), ...patch })) });

/** 노드를 지우면 연결선과, 그 노드의 테이블에 쓰는 행동 줄도 지운다 (쓸 곳이 없어진 행동과 그 빈도도) */
export const removeNode = (p: Project, id: string): Project => {
  const n = p.nodes.find((x) => x.id === id);
  const cleared = (n?.tables ?? []).reduce((acc, t) => removeTable(acc, id, t.name), p);
  return { ...cleared, nodes: cleared.nodes.filter((x) => x.id !== id), edges: cleared.edges.filter((e) => e.from !== id && e.to !== id) };
};

export function addNode(p: Project, layer: Layer): { project: Project; id: string } {
  let k = 1;
  while (p.nodes.some((n) => n.id === `${layer}-${k}`)) k++;
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

const RANK: Record<Verdict, number> = { ok: 0, unknown: 1, conditional: 2, fail: 3 };
/** 노드 배지: 붙은 항목 중 가장 나쁜 판정 */
export const worstVerdict = (j?: NodeJudgement): Verdict | undefined =>
  j?.items.reduce<Verdict | undefined>((w, i) => (!w || RANK[i.verdict] > RANK[w] ? i.verdict : w), undefined);

// ── 테이블 ──
type Table = ProjectNode['tables'][number];
type Action = Project['actions'][number];

const mapTables = (p: Project, nodeId: string, fn: (ts: Table[]) => Table[]): Project =>
  ({ ...p, nodes: p.nodes.map((n) => (n.id === nodeId ? { ...n, tables: fn(n.tables) } : n)) });

/** 명세서로 읽은 테이블을 노드에 넣는다. 이름이 같은 테이블은 바꾸고 나머지는 뒤에 붙인다 */
export function importTables(p: Project, nodeId: string, tables: Table[]): { project: Project; replaced: string[] } {
  const n = p.nodes.find((x) => x.id === nodeId)!;
  const replaced = tables.filter((t) => n.tables.some((x) => x.name === t.name)).map((t) => t.name);
  const project = mapTables(p, nodeId, (ts) => [
    ...ts.map((x) => tables.find((t) => t.name === x.name) ?? x),
    ...tables.filter((t) => !ts.some((x) => x.name === t.name)),
  ]);
  return { project, replaced };
}

/** 테이블 고치기. 이름이 바뀌면 그 테이블을 가리키는 행동도 같이 고친다 */
export function updateTable(p: Project, nodeId: string, name: string, patch: Partial<Table>): Project {
  const next = mapTables(p, nodeId, (ts) => ts.map((t) => (t.name === name ? { ...t, ...patch } : t)));
  if (patch.name === undefined || patch.name === name) return next;
  return { ...next, actions: next.actions.map((a) => ({ ...a, writes: a.writes.map((w) => (w.node === nodeId && w.table === name ? { ...w, table: patch.name! } : w)) })) };
}

/** 테이블을 지우면 그 테이블에 쓰는 행동 줄도 지우고, 쓸 곳이 없어진 행동은 없앤다 */
export function removeTable(p: Project, nodeId: string, name: string): Project {
  const next = mapTables(p, nodeId, (ts) => ts.filter((t) => t.name !== name));
  const actions = next.actions
    .map((a) => ({ ...a, writes: a.writes.filter((w) => !(w.node === nodeId && w.table === name)) }))
    .filter((a) => a.writes.length > 0);
  const gone = next.actions.filter((a) => !actions.some((x) => x.name === a.name)).map((a) => a.name);
  return dropRates({ ...next, actions }, gone);
}

export function addTable(p: Project, nodeId: string): Project {
  const n = p.nodes.find((x) => x.id === nodeId)!;
  let k = 1;
  while (n.tables.some((t) => t.name === `table_${k}`)) k++;
  return mapTables(p, nodeId, (ts) => [...ts, TableSchema.parse({ name: `table_${k}`, columns: [{ name: 'id', type: 'bigint' }], primary_key: ['id'] })]);
}

// ── 행동 ──
const dropRates = (p: Project, names: string[]): Project => (!names.length ? p : {
  ...p,
  personas: p.personas.map((ps) => ({ ...ps, action_rates: Object.fromEntries(Object.entries(ps.action_rates).filter(([k]) => !names.includes(k))) })),
});

export function addAction(p: Project): Project {
  const first = p.nodes.flatMap((n) => n.tables.map((t) => ({ node: n.id, table: t.name, rows: 1 })))[0];
  if (!first) return p;
  let k = 1;
  while (p.actions.some((a) => a.name === `행동 ${k}`)) k++;
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
  let k = 2;
  while (p.nodes.some((n) => n.id === `${node.id}-${k}`)) k++;
  const id = `${node.id}-${k}`;
  return { project: { ...p, nodes: [...p.nodes, { ...node, id, name: `${node.name} (복사)` }] }, id };
}
