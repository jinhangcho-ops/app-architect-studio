// 5절 판정: 노드에 붙은 카탈로그 항목마다 됨·조건부·안 됨·판단 불가와 이유, 통과하는 대안을 낸다.
import { MissingVar, test, type Value, type Vars } from './expr';
import { calibrate } from './calibrate';
import { LAYER_TIER, VERDICT_RANK, type Layer, type Verdict } from './model';
import { secs } from './pipeline';
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


/** computed = 엔진이 계산한 변수. 노드에 직접 넣은 vars가 있으면 그 값이 우선한다(실측·수동 보정). */
export const mergeScenario = (node: ProjectNode, computed?: Scenario): Scenario => ({
  normal: { ...computed?.normal, ...node.vars.normal },
  event: { ...computed?.event, ...node.vars.event },
});

const num = (v: Value | undefined) => (typeof v === 'number' ? v : undefined);

/** 항목 조건과 별개로 노드의 주 항목에 거는 문제: 사용률 100% 초과, 큐 지연이 허용을 넘음, 배치가 실행 창 안에 안 끝남.
 *  평소 피크에서 걸리면 안 됨, 이벤트 피크에서만 걸리면 조건부 (사용률 초과는 어느 쪽이든 안 됨: 늘릴 대수가 없어 요청이 끝없이 쌓인다) */
export const nodeIssues = (s: Scenario) => issues(s, false);

function issues(s: Scenario, recovery: boolean): { verdict: Verdict; reasons: string[] } | undefined {
  const reasons: string[] = [];
  let verdict: Verdict | undefined;
  const hit = (v: Verdict, why: string) => { reasons.push(why); if (!verdict || VERDICT_RANK[v] > VERDICT_RANK[verdict]) verdict = v; };
  for (const [k, name] of [['normal', '평소 피크'], ['event', '이벤트 피크']] as const) {
    const x = s[k], soft: Verdict = k === 'normal' ? 'fail' : 'conditional';
    const u = num(x.utilization), lag = num(x.queue_lag_s), max = num(x.max_lag_s), run = num(x.batch_run_s), win = num(x.batch_window_s);
    if (u !== undefined && u > 1) hit('fail', `${name}에서 사용률 ${Math.round(u * 100)}% — 늘릴 수 있는 대수를 다 써도 받지 못합니다 (100%를 넘으면 요청이 쌓여 응답이 끝없이 늦어집니다)`);
    if (lag !== undefined && max !== undefined && lag > max) {
      hit(soft, Number.isFinite(lag) ? `${name}에 큐 지연이 최대 ${secs(lag)}로 허용 ${secs(max)}를 넘습니다 (소비자 처리량이 도착을 따라가지 못하는 시간대가 있음)`
        : `${name}에 소비자가 하루 도착량을 따라잡지 못해 큐 적체가 끝없이 늘어납니다`);
    }
    if (run !== undefined && win !== undefined && run > win) hit(soft, `${name}에 배치 1회 실행이 ${secs(run)}로 실행 창 ${secs(win)} 안에 끝나지 않습니다`);
    if (verdict === 'fail') break;
  }
  if (recovery) recoveryIssues(s, hit);
  return verdict && { verdict, reasons: [...new Set(reasons)] };
}

/** 장애 목표(recovery)를 넣었을 때만: 존·리전 장애에 멈춤(화면이 멈추면 안 됨, 반영만 늦으면 조건부), 존 장애 직후 넘침(조건부: 자동 확장이 채움),
 *  복구 시간·잃는 데이터가 목표를 넘음(안 됨). 부하와 무관한 문제라 한계 사용자 찾기(nodeIssues)에는 넣지 않는다 */
function recoveryIssues(s: Scenario, hit: (v: Verdict, why: string) => void) {
  const x = s.normal, survive = x.survive;
  if (survive === undefined) return;
  const effect = x.node_stops ? '화면이 멈춥니다' : '반영이 늦어집니다';
  if (survive !== 'none') {
    if (x.zone_down === true) hit(x.node_stops ? 'fail' : 'conditional', `존 하나가 멈추면 이 노드가 멈추고 ${effect} (서버를 존 ${show(x.zones)}개에 둠 — 2개 이상에 나눠 두어야 함)`);
    else {
      const nu = num(x.zone_util), eu = num(s.event.zone_util);
      const over = nu !== undefined && nu > 1 ? ['평소 피크', nu] as const : eu !== undefined && eu > 1 ? ['이벤트 피크', eu] as const : undefined;
      if (over) hit('conditional', `${over[0]}에 존 하나가 멈추면 남은 서버 사용률이 ${Number.isFinite(over[1]) ? `${Math.round(over[1] * 100)}%` : '끝없음'} — 자동 확장이 남은 존에 대수를 채울 때까지 요청이 밀립니다`);
    }
  }
  if (survive === 'region' && x.region_down === true) hit(x.node_stops ? 'fail' : 'conditional', `리전이 멈추면 다른 리전 복사본이 없어 이 노드가 멈추고 ${effect}`);
  if (survive === 'region' && x.region_down !== true) {
    const nu = num(x.region_util), eu = num(s.event.region_util);
    const over = nu !== undefined && nu > 1 ? ['평소 피크', nu] as const : eu !== undefined && eu > 1 ? ['이벤트 피크', eu] as const : undefined;
    if (over) hit('conditional', `${over[0]}에 리전이 멈춰 대기 복사본으로 넘기면 사용률이 ${Math.round(over[1] * 100)}% — 복사본이 대수를 늘릴 때까지 요청이 밀립니다 (대기 대수를 늘리거나 active로)`);
  }
  const rto = num(x.target_rto_s);
  if (rto !== undefined) {
    const zr = num(x.zone_rto_s), rr = num(x.region_rto_s), br = num(x.restore_rto_s);
    if (survive !== 'none' && x.zone_down !== true && zr !== undefined && zr > rto) hit('fail', `존 장애 때 대기 서버로 넘기는 데 ${secs(zr)}로 목표 RTO ${secs(rto)}를 넘습니다`);
    if (survive === 'region' && x.region_down !== true && rr !== undefined && rr > rto) hit('fail', `리전 장애 때 다른 리전 복사본으로 넘기는 데 ${secs(rr)}로 목표 RTO ${secs(rto)}를 넘습니다`);
    if (br !== undefined && br > rto) hit('fail', `백업에서 되살리는 데 ${secs(br)}로 목표 RTO ${secs(rto)}를 넘습니다 (새 서버 준비 + 데이터 크기 / 되살리는 속도)`);
  }
  const rpo = num(x.target_rpo_s), r = num(x.rpo_s);
  if (rpo !== undefined && r !== undefined && r > rpo) {
    hit('fail', Number.isFinite(r) ? `장애 때 최대 ${secs(r)} 동안의 데이터를 잃어 목표 RPO ${secs(rpo)}를 넘습니다` : '백업도 다른 리전 복사본도 없어 장애 때 데이터를 되살릴 수 없습니다');
  }
}

export function judgeNode(node: ProjectNode, catalog: Map<string, CatalogItem>, computed?: Scenario): NodeJudgement {
  const s = mergeScenario(node, computed);
  const ids = itemIds(node);
  const items = ids.map((id) => {
    const item = catalog.get(id);
    if (!item) throw new Error(`${node.id}: 없는 카탈로그 항목 ${id}`);
    // 노드 문제(넘침·큐 지연·배치 창·장애 목표)를 주 항목에 걸고 이유를 맨 앞에 둔다. 항목 조건에 걸린 이유(연결 한도 등)도 같이 남긴다
    const base = judgeItem(item, node, s), issue = id === node.primary ? issues(s, true) : undefined;
    const j = issue && VERDICT_RANK[issue.verdict] >= VERDICT_RANK[base.verdict]
      ? { ...base, verdict: issue.verdict, reasons: [...issue.reasons, ...(base.verdict === 'ok' ? [] : base.reasons)] }
      : issue ? { ...base, reasons: [...base.reasons, ...issue.reasons] } : base;
    // 됨이 아니면 같은 노드·같은 변수로 대안을 판정해, 안 됨이 아닌 것만 좋은 순서로 남긴다
    const alternatives = j.verdict === 'ok' ? [] : item.alternatives
      .map((a) => ({ id: a.id, note: a.note, verdict: judgeItem(catalog.get(a.id)!, node, s).verdict }))
      .filter((a) => a.verdict !== 'fail')
      .sort((a, b) => VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict]);
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
