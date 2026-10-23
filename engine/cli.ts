// 사용법: npm run judge -- <프로젝트.json> [카탈로그 폴더]
import { fileURLToPath } from 'node:url';
import { judgeNode, checkRules } from './judge';
import { loadCatalog, loadProject } from './io';
import { computedScenarios } from './load';
import { VERDICT_NAMES } from './model';
import { traffic } from './traffic';

const [projectPath, catalogDir = fileURLToPath(new URL('../data/catalog', import.meta.url))] = process.argv.slice(2);
if (!projectPath) {
  console.error('사용법: npm run judge -- <프로젝트.json> [카탈로그 폴더]');
  process.exit(2);
}

const fmt = (v: number) => (v >= 100 ? Math.round(v).toLocaleString('ko-KR') : String(Math.round(v * 100) / 100));

try {
  const catalog = loadCatalog(catalogDir);
  const project = loadProject(projectPath, catalog.items);
  console.log(`# ${project.name}\n`);

  const t = traffic(project);
  if (t) {
    console.log('## 규모 (4절)');
    const rows: [string, keyof typeof t][] = [
      ['오늘 접속한 사용자(DAU)', 'dau'], ['현지 시간대 창 안 접속 비율', 'inWindowShare'], ['피크 1시간 비중', 'peakShare'],
      ['하루 요청', 'dailyRequests'], ['평균 RPS', 'avgRps'], ['피크 RPS', 'peakRps'], ['이벤트 피크 RPS', 'peakRpsEvent'],
      ['피크 쓰기/초', 'peakWriteRps'], ['이벤트 피크 쓰기/초', 'peakWriteRpsEvent'], ['순간 폭주 RPS', 'burstRps'],
      ['피크 동시 접속', 'concurrentPeak'], ['이벤트 동시 접속', 'concurrentPeakEvent'],
      ['보관 기간 데이터', 'storageGb'], ['여유분 포함', 'storageGbWithOverhead'], ['하루 송신', 'egressGbPerDay'],
      ['이벤트 피크 대역폭', 'bandwidthMbpsEvent'],
    ];
    for (const [label, key] of rows) {
      const mt = t[key];
      if (mt && !Array.isArray(mt)) {
        console.log(`  ${label}: ${mt.unit === '비율' ? `${(mt.value * 100).toFixed(1)}%` : `${fmt(mt.value)} ${mt.unit}`}`);
      }
    }
    console.log('');
  } else {
    const why = project.deploy.mode === 'local_exe' ? '로컬 exe라 서버 트래픽 없음' : '규모(scale)·페르소나가 없어 계산하지 않음';
    console.log(`(트래픽: ${why})\n`);
  }

  const computed = computedScenarios(project, t);
  console.log('## 판정');
  for (const node of project.nodes) {
    for (const j of judgeNode(node, catalog.byId, computed.get(node.id)).items) {
      console.log(`${VERDICT_NAMES[j.verdict]}  ${node.name} · ${catalog.byId.get(j.itemId)!.name}`);
      for (const r of j.reasons) console.log(`    ${r}`);
      for (const a of j.alternatives) {
        console.log(`    → 대안 ${VERDICT_NAMES[a.verdict]} ${catalog.byId.get(a.id)!.name}${a.note ? ` (${a.note})` : ''}`);
      }
    }
  }
  const hits = checkRules(project, catalog.rules);
  if (hits.length) console.log('\n## 구조 규칙');
  for (const h of hits) console.log(`❌ ${h.target}\n    ${h.why}\n    → ${h.instead}`);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
