import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseProject } from '../../engine/data';
import { NodeSchema } from '../../engine/schema';
import { catalog, examples } from './data';
import { findPlans, run } from './edit';
import { autoLayout } from './layout';
import { Report } from './Report';
import { netLines, nodeCard, openIssues } from './reportData';

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
  it('설계서 목차 15개 절이 순서대로 나오고, 노드마다 카드가 한 장', () => {
    const p = load('global-commerce.json');
    const html = renderToStaticMarkup(
      <Report project={p} analysis={run(p, today).analysis} positions={autoLayout(p)} plans={findPlans(p, today).result} today={today} onClose={() => {}} />,
    );
    const titles = [...html.matchAll(/<h2 class="r-h">(\d+)\. (.*?)<\/h2>/g)].map((m) => `${m[1]}. ${m[2].replace(/<!-- -->/g, '')}`);
    expect(titles).toEqual([
      '1. 요약', '2. 구동 방식', '3. 규모 가정', '4. 구조도', '5. 화면 설계 · API 호출 · 인터페이스 명세', '6. 데이터 명세 · 기능별 테이블 · 데이터 사전', '7. 노드별 선택과 판정 근거', '8. 확장 한계 · 지연시간 · 월 비용',
      '9. 최선 조합과 선택 조건', '10. 가용성 · 성장 타임라인', '11. 네트워크 · 보안', '12. 확인 필요 조문', '13. 미해결 ❌·⚠️ 목록', '14. 적용한 설정', '15. 카탈로그 출처',
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

describe('설계서: 네트워크·보안 장', () => {
  it('노드별 보안 값 표(정할 칸이 아니면 —, 비면 미정), 연결선 암호화·짐작한 망, ❌ 먼저인 점검 결과, 공개 노드의 STRIDE 점검표', () => {
    const p0 = load('ledger-fastapi.json');
    const p = {
      ...p0,
      nodes: p0.nodes.map((n) => (n.id === 'B-01' ? { ...n, security: { exposure: 'public' as const, tls: true, waf: false, rate_limit_rpm: 600 } } : n)),
      edges: p0.edges.map((e) => (e.from === 'U-01' && e.to === 'B-01' ? { ...e, security: { tls: 'none' as const } } : e)),
    };
    const html = renderToStaticMarkup(
      <Report project={p} analysis={run(p, today).analysis} positions={autoLayout(p)} today={today} onClose={() => {}} />,
    ).replace(/<!-- -->/g, '');
    const sec = html.slice(html.indexOf('네트워크 · 보안</h2>'), html.indexOf('확인 필요 조문</h2>'));
    // B-01 행: 공개 범위·TLS·저장 암호화(—)·비밀 보관(미정)·WAF(끔)·속도 제한(켬 600/분)
    expect(sec).toContain('<tr><td>장부 API (FastAPI)</td><td>인터넷 공개</td><td>켬</td><td>—</td><td>미정</td><td>끔</td><td>켬 (600/분)</td>');
    expect(sec).not.toContain('<td>Google Vision OCR</td>');
    expect(sec).toContain('<td>장부 PWA → 장부 API (FastAPI)</td><td>암호화 없음</td><td>인터넷 (짐작)</td>');
    expect(sec.indexOf('❌')).toBeLessThan(sec.indexOf('⚠️'));
    expect(sec).toContain('<th colSpan="3">장부 API (FastAPI)</th>');
    expect(sec).toContain('대량 요청을 막는지 (WAF 끔 · 속도 제한 켬 (600/분))');
    expect(html).toContain('효과가 적습니다');
  });
});

describe('설계서: 개인정보 컬럼 보호', () => {
  it('개인정보 컬럼에 보호가 없으면 설계서에 보호가 없다는 줄이 나옴', () => {
    const p0 = load('ledger-fastapi.json');
    const i = p0.nodes.findIndex((n) => n.tables.length);
    const p = { ...p0, nodes: p0.nodes.map((n, k) => (k === i ? { ...n, tables: n.tables.map((t, j) => (j === 0 ? { ...t, columns: t.columns.map((c, m) => (m === 0 ? { ...c, personal: true } : c)) } : t)) } : n)) };
    const html = renderToStaticMarkup(
      <Report project={p} analysis={run(p, today).analysis} positions={autoLayout(p)} today={today} onClose={() => {}} />,
    ).replace(/<!-- -->/g, '');
    expect(html).toContain('보호가 없습니다');
  });
});

describe('설계서: 인증·인가 표와 STRIDE 기호', () => {
  it('인증·인가 표(비면 미정)와 STRIDE 줄 앞 ✅·⚠️·미정이 나옴', () => {
    const p0 = load('ledger-fastapi.json');
    const p = {
      ...p0,
      auth: { method: 'jwt' as const, mfa: 'none' as const },
      nodes: p0.nodes.map((n) => (n.id === 'B-01' ? { ...n, security: { exposure: 'public' as const, tls: true, waf: false } } : n)),
    };
    const html = renderToStaticMarkup(
      <Report project={p} analysis={run(p, today).analysis} positions={autoLayout(p)} today={today} onClose={() => {}} />,
    ).replace(/<!-- -->/g, '');
    const sec = html.slice(html.indexOf('네트워크 · 보안</h2>'), html.indexOf('확인 필요 조문</h2>'));
    expect(sec).toContain('인증 · 인가');
    expect(sec).toContain('<tr><th>방식</th><td>JWT(자체 발급)</td></tr>');
    expect(sec).toContain('<tr><th>발급 노드</th><td>미정</td></tr>');
    const st = sec.slice(sec.indexOf('(STRIDE)'));
    // 줄 이름과 함께: TLS 켬 → 변조 ✅, WAF 끔 → 서비스 거부 ⚠️, 비밀 보관 비어 → 정보 노출 미정
    for (const [m, k] of [['✅', '변조'], ['⚠️', '서비스 거부'], ['미정', '정보 노출']]) expect(st).toContain(`<td>${m}</td><th>${k}</th>`);
  });
});

describe('설계서 노드 카드: 자동 확장 줄', () => {
  it('자동 확장을 단 API 노드는 계산 결과에 평소/이벤트 줄이 나옴', () => {
    const p0 = load('phase3.json');
    const p = { ...p0, nodes: p0.nodes.map((n) => (n.id === 'api' ? { ...n, autoscale: {} } : n)) };
    const calc = nodeCard(p, run(p, today).analysis!, catalog.byId, 'api').rows.find((r) => r.label === '📊 계산 결과')!.lines;
    expect(calc.find((l) => l.startsWith('자동 확장 평소'))).toMatch(/^자동 확장 평소 \d+~\d+대, 넘침 [\d.]+분\(최대 사용률 \d+%\) \/ 이벤트 \d+~\d+대, 넘침 [\d.]+분\(최대 사용률 \d+%\)/);
  });
});

describe('설계서 노드 카드: 대역폭·동시 연결 줄', () => {
  it('진입 게이트웨이 카드에 대역폭·동시 연결 평소/이벤트 줄이 나옴', () => {
    const p = load('phase3.json');
    const calc = nodeCard(p, run(p, today).analysis!, catalog.byId, 'lb').rows.find((r) => r.label === '📊 계산 결과')!.lines;
    expect(calc.some((l) => l.startsWith('대역폭 평소/이벤트'))).toBe(true);
    expect(calc.some((l) => l.startsWith('동시 연결 평소/이벤트'))).toBe(true);
  });
  it('한도가 연결에만 있으면 연결 줄에만 평소 / 이벤트 한도가 붙음', () => {
    const p = load('phase3.json');
    const q = { ...p, nodes: p.nodes.map((n) => (n.id === 'lb' ? { ...n, net: { max_connections: 5000 } } : n)) };
    const na = run(q, today).analysis!.nodes.lb;
    const [bw, cn] = netLines(na.net);
    expect(bw).not.toContain('한도');
    expect(cn).toContain(`(한도 ${(5000 * na.instances!.normal.value).toLocaleString()}`);
    expect(cn).toContain(` / ${(5000 * na.instances!.event.value).toLocaleString()}`);
  });
});

describe('설계서 노드 카드: 캐시 장애 줄', () => {
  it('영향 받는 DB 카드와 캐시 카드 둘 다 "캐시 장애:" 줄이 나옴', () => {
    const g = load('global-commerce.json');
    const p = {
      ...g,
      nodes: [...g.nodes, NodeSchema.parse({ id: 'C-1', name: '캐시', layer: 'cache', primary: 'redis_cache', hit_ratio: 0.8 })],
      edges: [...g.edges, { from: 'N-03', to: 'C-1', carries: 'read' as const, callRatio: 1, sync: true, rtt_ms: 0, interfaces: [] }],
    };
    const html = renderToStaticMarkup(
      <Report project={p} analysis={run(p, today).analysis} positions={autoLayout(p)} plans={findPlans(p, today).result} today={today} onClose={() => {}} />,
    );
    const cards = html.split('<div class="r-card-head">').slice(1);
    const cardOf = (id: string) => cards.find((c) => c.startsWith(`<b>[${id}]`))!;
    expect(cardOf('N-06')).toContain('캐시 장애:');
    expect(cardOf('C-1')).toContain('캐시 장애:');
  });
});
