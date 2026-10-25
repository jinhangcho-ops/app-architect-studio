// 설계서(7절): 프로젝트와 분석 결과로 설계서 내용을 만든다. 화면 그리기(Report.tsx)와 나눠 두어 내용만 테스트한다.
// 노드 카드는 설계서 7절 표의 행 순서를 그대로 따른다: 머리줄 → 판정 근거 → 선택 항목 → 동작 방식 → 계산 결과 → 대안 → 태그 → 연결 → 비고 → 설명.
import type { Analysis } from '../../engine/analyze';
import { impactOf } from '../../engine/availability';
import type { NodeJudgement } from '../../engine/judge';
import { LAYER_NAMES, VERDICT_NAMES, VERDICT_RANK, type Metric, type Verdict } from '../../engine/model';
import { itemIds, nodeStorageProfile, selectedFeatures, type CatalogItem, type Project } from '../../engine/schema';
import { flowLine } from '../../engine/pipeline';
import { lawLine } from '../../engine/regulation';
import { worstVerdict } from './edit';
import { fmt, fmtMetric } from './format';

export type Row = { label: string; lines: string[] };
export type NodeCard = { id: string; title: string; verdict?: Verdict; rows: Row[] };

const BASIS = { 실측: '실측', 사양보정: '사양 보정', 업계: '업계 기준값' } as const;
/** 숫자 하나: 값 + (공식 · 기준값 출처) */
const withHow = (label: string, m?: Metric) =>
  m ? `${label} ${fmtMetric(m)} — ${m.formula}${m.basis ? ` (${BASIS[m.basis]})` : ''}` : undefined;
const pair = (label: string, a?: Metric, b?: Metric) =>
  a && b ? `${label} ${fmtMetric(a)} / ${fmtMetric(b)} — ${a.formula}${a.basis ? ` (${BASIS[a.basis]})` : ''}` : undefined;
const some = (xs: (string | undefined | false)[]) => xs.filter((x): x is string => !!x);

export function nodeCard(p: Project, a: Analysis, byId: Map<string, CatalogItem>, nodeId: string): NodeCard {
  const n = p.nodes.find((x) => x.id === nodeId)!;
  const name = (id: string) => p.nodes.find((x) => x.id === id)?.name ?? id;
  const j: NodeJudgement | undefined = a.judgements.find((x) => x.nodeId === nodeId);
  const verdict = worstVerdict(j);
  const na = a.nodes[nodeId];
  const ids = itemIds(n);
  const items = ids.map((id) => byId.get(id)).filter((x): x is CatalogItem => !!x);
  const itemName = (id: string) => byId.get(id)?.name ?? id;

  const sp = nodeStorageProfile(n, byId);
  const features = sp ? selectedFeatures(sp, n).map((f) => f.label) : [];
  const cost = a.cost?.parts[nodeId];
  const edgeText = (e: Project['edges'][number]) =>
    `${e.sync ? '동기' : '비동기'}${e.callRatio !== 1 ? `, ×${e.callRatio}` : ''}${e.carries !== 'all' ? `, ${e.carries === 'write' ? '쓰기만' : '읽기만'}` : ''}${e.rtt_ms ? `, RTT ${e.rtt_ms}ms` : ''}`;
  const impact = Object.entries(impactOf(p, nodeId)).map(([ui, how]) => `${name(ui)} ${how === 'stopped' ? '멈춤' : '반영 지연'}`);
  const unknown = j?.items.filter((i) => i.verdict === 'unknown').flatMap((i) => i.reasons) ?? [];
  const tables = a.tables.filter((x) => x.nodeId === nodeId);

  const rows: Row[] = [
    { label: '★ 판정 근거', lines: j?.items.map((i) => `${VERDICT_NAMES[i.verdict]} ${itemName(i.itemId)}: ${i.reasons.join(' / ') || '조건을 모두 통과'}`) ?? [] },
    { label: '선택 항목', lines: items.map((it) => `${it.name} (${it.area} · ${it.id === n.primary ? '주 항목' : '보조 항목'})`) },
    { label: '⚡ 동작 방식', lines: [...items.flatMap((it) => (it.summary ? [`${it.name}: ${it.summary}`] : [])), ...(features.length ? [`저장 기능: ${features.join(', ')}`] : [])] },
    {
      label: '📊 계산 결과',
      lines: some([
        na?.load && `부하 평소/이벤트 ${fmt(na.load.rps.normal)} / ${fmt(na.load.rps.event)} RPS, 쓰기 ${fmt(na.load.writeRps.normal)} / ${fmt(na.load.writeRps.event)}건/초`,
        withHow('대당 처리량', na?.perInstanceRps),
        pair('필요 대수 평소/이벤트', na?.instances?.normal, na?.instances?.event),
        pair('사용률 평소/이벤트', na?.utilization?.normal, na?.utilization?.event),
        pair('p99 평소/이벤트', na?.p99?.normal, na?.p99?.event),
        withHow('가용성', na?.availability),
        withHow('월 비용', cost),
        withHow('한계 사용자', na?.limitUsers),
        pair('DB 연결 수 평소/이벤트', na?.connections?.normal, na?.connections?.event),
        ...a.pipeline.filter((f) => f.from === nodeId || f.to === nodeId).map((f) => flowLine(f, name)),
        ...tables.map((x) => `테이블 ${x.table}: 하루 ${fmt(x.newRowsPerDay.value)}행 · 행 ${fmt(x.rowBytes.value)}B + 인덱스 ${fmt(x.indexBytesPerRow.value)}B · ${fmt(x.storedGb.value)}GB${x.partitions ? ` (파티션 ${x.partitions.count}개)` : ''}`),
      ]),
    },
    {
      label: '💡 대안',
      lines: j?.items.flatMap((i) => i.alternatives.map((alt) => {
        const better = byId.get(i.itemId)?.alternatives.find((x) => x.id === alt.id)?.better_for ?? [];
        return `${VERDICT_NAMES[alt.verdict]} ${itemName(alt.id)}${better.length ? ` — ${better.join('·')}에 더 좋음` : ''}${alt.note ? ` (${alt.note})` : ''}`;
      })) ?? [],
    },
    { label: '🏷 태그', lines: [[...new Set(items.map((it) => `#${it.kind}`))].join(' · ') + (items.length ? ` · ${[...new Set(items.map((it) => it.area))].join(' · ')}` : '')].filter((x) => x.trim()) },
    {
      label: '연결',
      lines: [
        ...p.edges.filter((e) => e.to === nodeId).map((e) => `${name(e.from)} → 이 노드 (${edgeText(e)})`),
        ...p.edges.filter((e) => e.from === nodeId).map((e) => `이 노드 → ${name(e.to)} (${edgeText(e)})`),
      ],
    },
    {
      label: '비고',
      lines: some([
        a.spof.includes(nodeId) && `단일 장애점 (이중화 ${n.replicas}대)`,
        impact.length > 0 && `멈추면: ${impact.join(', ')}`,
        ...a.regulation.filter((h) => h.nodeId === nodeId).map((h) => lawLine(h)),
        ...unknown,
      ]),
    },
    { label: '설명', lines: n.description ? [n.description] : [] },
  ];
  return {
    id: nodeId,
    title: `[${nodeId}] ${n.name} · ${LAYER_NAMES[n.layer]}`,
    verdict,
    // 설계서 7절: 행 순서는 카드마다 같게 두고 빈 행은 '없음'으로 보인다. 설명만 있을 때 싣는다
    rows: rows.filter((r) => r.lines.length || r.label !== '설명'),
  };
}

/** 미해결 목록(10번째 절): 안 됨·조건부·판단 불가 항목과 걸린 구조 규칙 */
export function openIssues(p: Project, a: Analysis, byId: Map<string, CatalogItem>): string[] {
  const name = (id: string) => p.nodes.find((x) => x.id === id)?.name ?? id;
  return [
    ...a.judgements.flatMap((j) => j.items.filter((i) => i.verdict !== 'ok').map((i) => ({ v: i.verdict, text: `${VERDICT_NAMES[i.verdict]} ${name(j.nodeId)} · ${byId.get(i.itemId)?.name ?? i.itemId}: ${i.reasons[0] ?? ''}` })))
      // 나쁜 것부터
      .sort((x, y) => VERDICT_RANK[y.v] - VERDICT_RANK[x.v]).map((x) => x.text),
    ...a.rules.map((r) => `❌ 구조 규칙 · ${r.target}: ${r.why} → ${r.instead}`),
  ];
}

/** 카탈로그 출처(12번째 절): 고른 항목의 출처와 계산에 쓴 가격 행 */
export function sourcesOf(p: Project, byId: Map<string, CatalogItem>): { item: string; urls: string[] }[] {
  const ids = [...new Set(p.nodes.flatMap(itemIds))];
  return ids.map((id) => byId.get(id)).filter((x): x is CatalogItem => !!x).map((it) => ({ item: it.name, urls: it.sources }));
}

/** 성장 한계 한 줄 (결과 패널·설계서) */
export const milestoneText = (ms: { month?: number; startMonth?: number }) =>
  ms.month === undefined ? '성장해도 닿지 않음' : `${ms.month}개월째 한계, ${ms.startMonth}개월째 착수`;
/** 월 비용을 0·6·12·24개월째로 (결과 패널·설계서) */
export const costTimeline = (monthly: (Metric | undefined)[]) =>
  [0, 6, 12, 24].filter((mo) => mo < monthly.length).map((mo) => `${mo}개월째 ${fmtMetric(monthly[mo])}`).join(' · ');
