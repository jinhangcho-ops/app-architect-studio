import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseProject } from '../../engine/data';
import { catalog, examples } from './data';
import { findPlans, run } from './edit';
import { autoLayout } from './layout';
import { Report } from './Report';
import { nodeCard, openIssues } from './reportData';

const today = '2026-10-24';
const load = (name: string) => { const ex = examples.find((e) => e.name === name)!; return parseProject(ex.data, catalog.items, ex.name); };

describe('설계서 노드 카드 (설계서 7절 형식)', () => {
  const p = load('phase3.json');
  const a = run(p, today).analysis!;
  const card = nodeCard(p, a, catalog.byId, 'api');

  it('행 순서가 설계서 표와 같음', () => {
    expect(card.title).toBe('[api] 주문 API · 백엔드 서비스');
    expect(card.rows.map((r) => r.label)).toEqual(['★ 판정 근거', '선택 항목', '⚡ 동작 방식', '📊 계산 결과', '💡 대안', '🏷 태그', '연결', '비고']);
  });

  it('계산 결과는 값마다 공식과 기준값 출처를 붙임', () => {
    const calc = card.rows.find((r) => r.label === '📊 계산 결과')!.lines;
    expect(calc[0]).toMatch(/^부하 평소\/이벤트 [\d,.]+ \/ [\d,.]+ RPS/);
    // 노드에 사양(vCPU 2)이 있어 기준값을 사양으로 보정했다
    expect(calc.find((l) => l.startsWith('대당 처리량'))).toMatch(/\(사양 보정\)$/);
    expect(calc.find((l) => l.startsWith('월 비용'))).toMatch(/USD — /);
  });

  it('연결은 들어오고 나가는 선, 비고는 단일 장애점과 멈추는 화면', () => {
    expect(card.rows.find((r) => r.label === '연결')!.lines).toEqual(['게이트웨이 → 이 노드 (동기, RTT 1ms)', '이 노드 → 주문 DB (동기, RTT 1ms)']);
    expect(card.rows.find((r) => r.label === '비고')!.lines).toEqual(['단일 장애점 (이중화 1대)', '멈추면: 웹 화면 멈춤']);
  });

  it('개인정보 노드 카드에는 확인 필요 조문, 테이블 노드 카드에는 테이블 크기가 들어감', () => {
    const g = load('global-commerce.json');
    const ga = run(g, today).analysis!;
    const c = nodeCard(g, ga, catalog.byId, 'N-06');
    expect(c.rows.find((r) => r.label === '비고')!.lines.some((l) => l.includes('제28조의8 확인 필요'))).toBe(true);
    expect(c.rows.find((r) => r.label === '📊 계산 결과')!.lines.some((l) => l.startsWith('테이블 ledger_entries'))).toBe(true);
    expect(openIssues(g, ga, catalog.byId).some((x) => x.includes('구조 규칙'))).toBe(true);
  });
});

describe('설계서 전체', () => {
  it('설계서 목차 12개 절이 순서대로 나오고, 노드마다 카드가 한 장', () => {
    const p = load('global-commerce.json');
    const html = renderToStaticMarkup(
      <Report project={p} analysis={run(p, today).analysis} positions={autoLayout(p)} plans={findPlans(p, today).result} today={today} onClose={() => {}} />,
    );
    const titles = [...html.matchAll(/<h2 class="r-h">(\d+)\. (.*?)<\/h2>/g)].map((m) => `${m[1]}. ${m[2].replace(/<!-- -->/g, '')}`);
    expect(titles).toEqual([
      '1. 요약', '2. 구동 방식', '3. 규모 가정', '4. 구조도', '5. 노드별 선택과 판정 근거', '6. 확장 한계 · 지연시간 · 월 비용',
      '7. 최선 조합과 선택 조건', '8. 가용성 · 성장 타임라인', '9. 확인 필요 조문', '10. 미해결 ❌·⚠️ 목록', '11. 적용한 설정', '12. 카탈로그 출처',
    ]);
    expect(html.match(/class="r-card /g)).toHaveLength(p.nodes.length);
  });
});
