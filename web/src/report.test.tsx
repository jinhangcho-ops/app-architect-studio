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
    // 미해결 목록은 나쁜 것부터: 안 됨 → 판단 불가 → 조건부 (조건부·판단 불가가 섞인 판정으로 확인)
    const it = (verdict: 'conditional' | 'unknown' | 'fail') => ({ itemId: verdict, verdict, reasons: [], alternatives: [] });
    const mixed = { ...ga, judgements: [{ nodeId: g.nodes[0].id, items: [it('conditional'), it('unknown'), it('fail')] }], rules: [] };
    const lines = openIssues(g, mixed, catalog.byId);
    expect(['❌', '❔', '⚠️'].map((mark, i) => lines[i].startsWith(mark))).toEqual([true, true, true]);
  });
});

describe('설계서 전체', () => {
  it('설계서 목차 14개 절이 순서대로 나오고, 노드마다 카드가 한 장', () => {
    const p = load('global-commerce.json');
    const html = renderToStaticMarkup(
      <Report project={p} analysis={run(p, today).analysis} positions={autoLayout(p)} plans={findPlans(p, today).result} today={today} onClose={() => {}} />,
    );
    const titles = [...html.matchAll(/<h2 class="r-h">(\d+)\. (.*?)<\/h2>/g)].map((m) => `${m[1]}. ${m[2].replace(/<!-- -->/g, '')}`);
    expect(titles).toEqual([
      '1. 요약', '2. 구동 방식', '3. 규모 가정', '4. 구조도', '5. 화면 설계 · API 호출 · 인터페이스 명세', '6. 데이터 명세 · 기능별 테이블 · 데이터 사전', '7. 노드별 선택과 판정 근거', '8. 확장 한계 · 지연시간 · 월 비용',
      '9. 최선 조합과 선택 조건', '10. 가용성 · 성장 타임라인', '11. 확인 필요 조문', '12. 미해결 ❌·⚠️ 목록', '13. 적용한 설정', '14. 카탈로그 출처',
    ]);
    expect(html.match(/class="r-card /g)).toHaveLength(p.nodes.length);
    // 5절: 연결선의 인터페이스 명세 (주문 API → 세금 엔진 gRPC, → Kafka 메시지)
    expect(html).toContain('서비스 내부 인터페이스 명세');
    expect(html).toContain('gRPC QuoteTax');
    expect(html).toContain('메시지 orders.created');
    expect(html).toContain('데이터 사전');
  });
});

describe('설계서: 설계 메모 장과 노드 메모', () => {
  it('메모 장이 1장부터 맨 앞, 계산 장은 그 뒤 번호. 표·코드는 그려지고 HTML은 글자로, 노드 설명은 7장 카드의 메모', () => {
    const p = load('phase3.json');
    const notes = [
      { title: '3. 개요', body: '| 영역 | 선택 |\n|---|---|\n| 앱 | **React** |\n\n```sql\ncreate table t (id int);\n```\n<script>alert(1)</script>' },
      { title: '  ', body: '- 범위' },
    ];
    const withNotes = { ...p, notes, nodes: p.nodes.map((n) => (n.id === 'api' ? { ...n, description: '- 주문 접수\n- 결제 호출' } : n)) };
    const html = renderToStaticMarkup(
      <Report project={withNotes} analysis={run(withNotes, today).analysis} positions={autoLayout(withNotes)} today={today} onClose={() => {}} />,
    );
    const heads = [...html.matchAll(/<h2 class="r-h">(.*?)<\/h2>/g)].map((m) => m[1]);
    expect(heads.slice(0, 4)).toEqual(['1. 개요', '2. (제목 없음)', '3. 요약', '4. 구동 방식']);
    expect(heads).toContain('9. 노드별 선택과 판정 근거');
    expect(html).toContain('<table class="note-table"><thead><tr><th>영역</th><th>선택</th></tr></thead><tbody><tr><td>앱</td><td><b>React</b></td></tr></tbody></table>');
    expect(html).toContain('<pre class="note-code">create table t (id int);</pre>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toMatch(/<div class="r-memo"><b>메모<\/b><div class="note"><div class="note-list">.*주문 접수.*결제 호출/);
    // 날것의 설명 줄은 카드 표에 다시 나오지 않음 (메모로 한 번만)
    expect(html.match(/주문 접수/g)).toHaveLength(1);
  });
});
