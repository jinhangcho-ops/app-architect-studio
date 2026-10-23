// 화면의 편집 동작을 순수 함수로 둔다(store와 테스트가 같이 씀). 모두 새 Project를 돌려준다.
import { analyze, type Analysis } from '../../engine/analyze';
import { parseProject } from '../../engine/data';
import type { NodeJudgement } from '../../engine/judge';
import { LAYER_NAMES, type Layer, type Verdict } from '../../engine/model';
import { EdgeSchema, NodeSchema, type Project, type ProjectEdge, type ProjectNode } from '../../engine/schema';
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

export const updateNode = (p: Project, id: string, patch: Partial<ProjectNode>): Project =>
  ({ ...p, nodes: p.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) });

export const removeNode = (p: Project, id: string): Project =>
  ({ ...p, nodes: p.nodes.filter((n) => n.id !== id), edges: p.edges.filter((e) => e.from !== id && e.to !== id) });

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
