// 5절 판정: 노드에 붙은 카탈로그 항목마다 됨·조건부·안 됨·판단 불가와 이유, 통과하는 대안을 낸다.
import { MissingVar, test, type Value, type Vars } from './expr';
import { calibrate } from './calibrate';
import { LAYER_TIER, type Layer, type Verdict } from './model';
import { itemIds, type CatalogItem, type Project, type ProjectNode, type Rule } from './schema';

export type Scenario = { normal: Vars; event: Vars };
export type ItemJudgement = {
  itemId: string;
  verdict: Verdict;
  reasons: string[];
  /** 판단에 필요한데 값이 없는 변수 (verdict가 unknown일 때) */
  missing?: string[];
  alternatives: { id: string; verdict: Verdict; note?: string }[];
};
export type NodeJudgement = { nodeId: string; items: ItemJudgement[] };
export type RuleHit = { ruleId: string; target: string; why: string; instead: string };

const show = (v: Value) => (typeof v === 'number' ? String(Math.round(v * 100) / 100) : String(v));
const fill = (why: string, vars: Vars) => why.replace(/\{([\w.]+)\}/g, (m, k: string) => (k in vars ? show(vars[k]) : m));

/** 항목의 기준값을 노드 사양·실측으로 보정해 th.이름 변수로 만든다. 값이 없는 기준값은 빠진다. */
function thresholdVars(item: CatalogItem, node: ProjectNode): Vars {
  const out: Vars = {};
  for (const [name, th] of Object.entries(item.thresholds)) {
    const m = calibrate(th, node.spec, node.measured[name]);
    if (m) out[`th.${name}`] = m.value;
  }
  return out;
}

/** 조건마다 따로 평가해, 값이 없는 변수가 있어도 다른 조건의 판정은 살린다. */
function check(conds: CatalogItem['fails_when'], vars: Vars) {
  const hit: CatalogItem['fails_when'] = [];
  const missing = new Set<string>();
  for (const c of conds) {
    try {
      if (test(c.if, vars)) hit.push(c);
    } catch (e) {
      if (e instanceof MissingVar) missing.add(e.varName);
      else throw e;
    }
  }
  return { hit, missing: [...missing] };
}

/** 한계 찾기용: 기준값 보정은 한 번만 하고, 주어진 부하 변수에서 '안 됨' 조건에 걸리는지만 본다 (judgeItem의 첫 검사와 같다) */
export function failsWith(item: CatalogItem, node: ProjectNode) {
  const th = thresholdVars(item, node);
  return (vars: Vars) => check(item.fails_when, { ...vars, ...th }).hit.length > 0;
}

export function judgeItem(item: CatalogItem, node: ProjectNode, s: Scenario): Omit<ItemJudgement, 'alternatives'> {
  const th = thresholdVars(item, node);
  const normal = { ...s.normal, ...th };
  const event = { ...s.event, ...th };
  const n = check(item.fails_when, normal);
  if (n.hit.length) return { itemId: item.id, verdict: 'fail', reasons: n.hit.map((c) => fill(c.why, normal)) };
  const e = check(item.fails_when, event);
  if (e.hit.length) {
    return { itemId: item.id, verdict: 'conditional', reasons: e.hit.map((c) => `이벤트 피크에서: ${fill(c.why, event)}`) };
  }
  const missing = [...new Set([...n.missing, ...e.missing])];
  if (missing.length) return { itemId: item.id, verdict: 'unknown', reasons: [`값이 없어 판단할 수 없음: ${missing.join(', ')}`], missing };
  const ok = check(item.works_when, normal).hit.map((c) => fill(c.why, normal));
  return { itemId: item.id, verdict: 'ok', reasons: ok };
}

const RANK: Record<Verdict, number> = { ok: 0, conditional: 1, unknown: 2, fail: 3 };

/** computed = 엔진이 계산한 변수. 노드에 직접 넣은 vars가 있으면 그 값이 우선한다(실측·수동 보정). */
export const mergeScenario = (node: ProjectNode, computed?: Scenario): Scenario => ({
  normal: { ...computed?.normal, ...node.vars.normal },
  event: { ...computed?.event, ...node.vars.event },
});

export function judgeNode(node: ProjectNode, catalog: Map<string, CatalogItem>, computed?: Scenario): NodeJudgement {
  const s = mergeScenario(node, computed);
  const ids = itemIds(node);
  const items = ids.map((id) => {
    const item = catalog.get(id);
    if (!item) throw new Error(`${node.id}: 없는 카탈로그 항목 ${id}`);
    const j = judgeItem(item, node, s);
    // 됨이 아니면 같은 노드·같은 변수로 대안을 판정해, 안 됨이 아닌 것만 좋은 순서로 남긴다
    const alternatives = j.verdict === 'ok' ? [] : item.alternatives
      .map((a) => ({ id: a.id, note: a.note, verdict: judgeItem(catalog.get(a.id)!, node, s).verdict }))
      .filter((a) => a.verdict !== 'fail')
      .sort((a, b) => RANK[a.verdict] - RANK[b.verdict]);
    return { ...j, alternatives };
  });
  return { nodeId: node.id, items };
}

/** 항목과 무관한 구조 규칙(v2의 화면→DB 직결, 역방향 호출 등)을 연결선·프로젝트 단위로 검사한다. */
/** tables: 테이블 크기 계산이 만든 table 범위 변수 (target = '노드.테이블') */
export function checkRules(p: Project, rules: Rule[], tables: { target: string; vars: Vars }[] = []): RuleHit[] {
  const layerOf = new Map(p.nodes.map((n) => [n.id, n.layer]));
  const nameOf = new Map(p.nodes.map((n) => [n.id, n.name]));
  const hits: RuleHit[] = [];
  const run = (scope: Rule['scope'], target: string, vars: Vars) => {
    for (const r of rules.filter((x) => x.scope === scope)) {
      try {
        if (test(r.if, vars)) hits.push({ ruleId: r.id, target, why: fill(r.why, vars), instead: r.instead });
      } catch (e) {
        // table 규칙은 서버 메모리처럼 노드마다 없을 수 있는 값을 쓴다. 값이 없으면 그 규칙만 건너뛴다
        if (!(e instanceof MissingVar && scope === 'table')) throw e;
      }
    }
  };
  for (const t of tables) run('table', t.target, t.vars);
  for (const e of p.edges) {
    const from = layerOf.get(e.from)!, to = layerOf.get(e.to)!;
    run('edge', `${nameOf.get(e.from)} → ${nameOf.get(e.to)}`, {
      from_layer: from, to_layer: to, from_tier: LAYER_TIER[from], to_tier: LAYER_TIER[to], sync: e.sync,
      from_name: nameOf.get(e.from)!, to_name: nameOf.get(e.to)!,
    });
  }
  const has = (l: Layer) => p.nodes.some((n) => n.layer === l);
  run('project', p.name, { has_ui: has('ui'), has_backend: has('backend'), has_gateway: has('gateway') });
  return hits;
}
