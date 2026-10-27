// 사용법: npm run judge -- <프로젝트.json> [카탈로그 폴더] [가격표 폴더]
import { fileURLToPath } from 'node:url';
import { analyze } from './analyze';
import { PATHS_CUT_TEXT } from './latency';
import { loadCatalog, loadLaws, loadPrices, loadProject } from './io';
import { VERDICT_NAMES, type Metric } from './model';
import { failureLines } from './failure';
import { GAP_EFFECT, recordBytes, specAdvice, specGaps } from './interfaces';
import type { Interface } from './schema';
import { featureTables, unusedTables } from './tables';
import { schemaWarnings } from './ddl';
import { flowLine } from './pipeline';
import { lawLine } from './regulation';
import { STALE_DAYS } from './cost';

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const [projectPath, catalogDir = here('../data/catalog'), pricesDir = here('../data/prices')] = process.argv.slice(2);
if (!projectPath) {
  console.error('사용법: npm run judge -- <프로젝트.json> [카탈로그 폴더] [가격표 폴더]');
  process.exit(2);
}

const fmt = (v: number) => (!Number.isFinite(v) ? '∞' : v >= 100 ? Math.round(v).toLocaleString('ko-KR') : String(Math.round(v * 100) / 100));
const KIND: Record<Interface['kind'], string> = { rest: 'REST', grpc: 'gRPC', message: '메시지', file: '파일·전문' };
/** 인터페이스 방식. 파일·전문은 장 형식과 레코드 길이(가변장은 어림)까지 */
const way = (i: Interface) => {
  if (i.kind !== 'file') return KIND[i.kind];
  const r = i.record, len = recordBytes(i);
  return `${KIND.file} ${!r ? '장 형식 미정' : r.format === 'fixed' ? '고정장' : '가변장'}${len === undefined ? '' : ` · 레코드 ${r?.format === 'fixed' ? '' : '약 '}${len}바이트`}`;
};
const show = (mt: Metric) => (mt.unit === '비율' ? `${(mt.value * 100).toFixed(mt.value > 0.99 ? 3 : 1)}%` : `${fmt(mt.value)} ${mt.unit}`);

try {
  const catalog = loadCatalog(catalogDir);
  const project = loadProject(projectPath, catalog.items);
  // 사용자 PC의 날짜 (toISOString은 UTC라 한국에서는 오전 9시 전에 어제 날짜가 된다)
  const today = new Date().toLocaleDateString('sv-SE');
  const a = analyze(project, { catalog: catalog.byId, rules: catalog.rules, prices: loadPrices(pricesDir), laws: loadLaws(fileURLToPath(new URL('../data/laws', import.meta.url))) }, today);
  const nameOf = (id: string) => project.nodes.find((n) => n.id === id)!.name;
  console.log(`# ${project.name}\n`);

  const t = a.traffic;
  if (t) {
    console.log('## 규모');
    const rows: [string, keyof typeof t][] = [
      ['오늘 접속한 사용자(DAU)', 'dau'], ['현지 시간대 창 안 접속 비율', 'inWindowShare'], ['피크 1시간 비중', 'peakShare'],
      ['하루 요청', 'dailyRequests'], ['평균 RPS', 'avgRps'], ['피크 RPS', 'peakRps'], ['이벤트 피크 RPS', 'peakRpsEvent'],
      ['피크 쓰기/초', 'peakWriteRps'], ['이벤트 피크 쓰기/초', 'peakWriteRpsEvent'], ['순간 폭주 RPS', 'burstRps'],
      ['피크 동시 접속', 'concurrentPeak'], ['이벤트 동시 접속', 'concurrentPeakEvent'],
      ['보관 기간 데이터', 'storageGb'], ['여유분 포함', 'storageGbWithOverhead'], ['하루 송신', 'egressGbPerDay'],
      ['이벤트 피크 대역폭', 'bandwidthMbpsEvent'],
    ];
    for (const [label, key] of rows) {
      const mt = t[key] as Metric | undefined;
      if (mt) console.log(`  ${label}: ${show(mt)}`);
    }
    for (const [k, x] of Object.entries(t.tables)) console.log(`  테이블 ${k}: ${show(x.rowsPerDay)}, 피크 ${show(x.peakRowsPerSec)}`);
    for (const s of t.assumptions) console.log(`  ⚠️ ${s}`);
  } else {
    const why = project.deploy.mode === 'local_exe' ? '로컬 exe라 서버 트래픽 없음' : '규모(scale)·페르소나가 없어 계산하지 않음';
    console.log(`(트래픽: ${why})`);
  }

  console.log('\n## 노드 (평소 / 이벤트)');
  for (const n of project.nodes) {
    const x = a.nodes[n.id];
    const parts = [`가용성 ${show(x.availability)}`];
    if (x.load) parts.unshift(`부하 ${fmt(x.load.rps.normal)} / ${fmt(x.load.rps.event)} RPS`);
    if (x.instances) parts.push(`필요 ${x.instances.normal.value} / ${x.instances.event.value}대`);
    if (x.utilization) parts.push(`사용률 ${show(x.utilization.normal)} / ${show(x.utilization.event)}`);
    if (x.p99) parts.push(`p99 ${fmt(x.p99.normal.value)} / ${fmt(x.p99.event.value)} ms`);
    if (x.limitUsers) parts.push(x.limitUsers.value === 0 ? '부하와 무관하게 이미 안 됨' : `한계 ${fmt(x.limitUsers.value)}명`);
    console.log(`  ${n.name}: ${parts.join(' · ')}`);
  }
  if (a.bottleneck) {
    const b = a.bottleneck;
    console.log(`  → 첫 병목: ${nameOf(b.nodeId)} (${b.limitUsers.value === 0 ? '지금 구조에서 이미 안 됨' : `활성 사용자 ${fmt(b.limitUsers.value)}명에서 안 됨`})`);
  }
  if (a.spof.length) console.log(`  → 단일 장애점: ${a.spof.map(nameOf).join(', ')}`);

  if (a.pipeline.length) console.log('\n## 데이터 파이프라인 (평소 / 이벤트)');
  for (const f of a.pipeline) console.log(`  ${flowLine(f, nameOf)}`);

  const specs = project.edges.flatMap((e) => e.interfaces.map((i) => ({ e, i, gaps: specGaps(i) })));
  if (specs.length) {
    console.log('\n## 인터페이스 명세 점검');
    for (const { e, i, gaps } of specs) console.log(`  ${gaps.length ? '⚠️' : '✅'} ${nameOf(e.from)} → ${nameOf(e.to)} · ${i.name} (${way(i)})${gaps.length ? `: ${gaps.join(', ')}` : ''}`);
    if (specs.some((x) => x.gaps.length)) console.log(`  → ${GAP_EFFECT}`);
    for (const x of specAdvice(project)) {
      console.log(`  💡 ${nameOf(x.nodeId)} — ${x.title}: ${x.text}${x.file ? ` (${x.file})` : ''}`);
      for (const w of x.warnings ?? []) console.log(`     ⚠️ ${w}`);
    }
  }

  const feats = featureTables(project), unused = new Set(unusedTables(project)), warns = schemaWarnings(project, catalog.byId);
  const unusedNames = project.nodes.flatMap((n) => n.tables.filter((x) => unused.has(`${n.id}.${x.name}`)).map((x) => `${n.name}.${x.name}`));
  if (feats.length || unused.size || warns.length) console.log('\n## 기능별 테이블');
  for (const f of feats) console.log(`  ${f.name} (${f.via === '행동' ? f.via : f.via.split(' → ').map(nameOf).join(' → ')}): ${f.tables.map((x) => `${nameOf(x.node)}.${x.table} ${x.op === 'read' ? '읽기' : '쓰기'}`).join(', ')}`);
  if (unusedNames.length) console.log(`  ⚠️ 어느 기능에도 연결되지 않은 테이블: ${unusedNames.join(', ')}`);
  for (const w of warns) console.log(`  ⚠️ ${nameOf(w.node)}${w.table ? `.${w.table}` : ''}: ${w.text}`);

  if (a.failure) console.log('\n## 장애 시나리오 (사용률: 평소 / 이벤트)');
  for (const l of a.failure ? failureLines(a.failure, nameOf) : []) console.log(`  ${l}`);

  if (a.paths.length) console.log('\n## 동기 경로');
  if (a.pathsCut) console.log(`  ! ${PATHS_CUT_TEXT}`);
  for (const path of a.paths) {
    const p99 = path.p99 ? `p99 ${fmt(path.p99.value)} ms · ` : '';
    console.log(`  ${path.nodes.map(nameOf).join(' → ')}: ${p99}가용성 ${show(path.availability)} · 월 중단 ${fmt(path.downtime.value)}시간`);
  }

  if (a.cost) {
    console.log('\n## 월 비용');
    for (const [k, mt] of Object.entries(a.cost.parts)) console.log(`  ${project.nodes.some((n) => n.id === k) ? nameOf(k) : k}: ${fmt(mt.value)} ${mt.unit}`);
    if (a.cost.total) console.log(`  합계: ${fmt(a.cost.total.value)} ${a.cost.total.unit}`);
    if (a.cost.missing.length) console.log(`  ⚠️ 가격표에 없는 상품: ${a.cost.missing.join(', ')}`);
    if (a.cost.stale.length) console.log(`  ⚠️ 기준일이 ${STALE_DAYS}일 넘은 가격: ${a.cost.stale.join(', ')}`);
  }

  if (a.growth) {
    console.log('\n## 성장 타임라인');
    for (const ms of a.growth.milestones) {
      const when = ms.month === undefined ? '도달하지 않음' : `${ms.month}개월째 한계 → ${ms.startMonth}개월째 착수`;
      console.log(`  ${nameOf(ms.nodeId)}: ${when} (한계 ${fmt(ms.limitUsers)}명)`);
    }
    const costs = a.growth.monthlyCost;
    if (costs.length) {
      const pick = [0, 6, 12, 18, 24].filter((mo) => mo < costs.length && costs[mo]);
      console.log(`  월 비용: ${pick.map((mo) => `${mo}개월 ${fmt(costs[mo]!.value)}`).join(' · ')} ${costs[0]?.unit ?? ''}`);
    }
  }

  console.log('\n## 판정');
  for (const j of a.judgements) {
    for (const it of j.items) {
      console.log(`${VERDICT_NAMES[it.verdict]}  ${nameOf(j.nodeId)} · ${catalog.byId.get(it.itemId)!.name}`);
      for (const r of it.reasons) console.log(`    ${r}`);
      for (const alt of it.alternatives) {
        console.log(`    → 대안 ${VERDICT_NAMES[alt.verdict]} ${catalog.byId.get(alt.id)!.name}${alt.note ? ` (${alt.note})` : ''}`);
      }
    }
  }
  if (a.rules.length) console.log('\n## 구조 규칙');
  for (const h of a.rules) console.log(`❌ ${h.target}\n    ${h.why}\n    → ${h.instead}`);
  if (a.regulation.length) console.log('\n## 확인 필요 조문 (법률 검토를 대신하지 않음)');
  for (const h of a.regulation) {
    const name = project.nodes.find((n) => n.id === h.nodeId)?.name ?? h.nodeId;
    console.log(`⚖️  ${name}: ${lawLine(h)}`);
  }
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
