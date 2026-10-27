import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCatalog, loadProject } from '../io';
import type { Project } from '../schema';
import { checkSecurity, edgeNet } from '../security';

const root = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const catalog = loadCatalog(root('data/catalog'));
// 장부 앱: PWA(U-01) → FastAPI(B-01) → Supabase(D-01), FastAPI → Google Vision(X-01), 크론(J-01) → FastAPI
const ledger = loadProject(root('examples/ledger-fastapi.json'), catalog.items);

type Sec = NonNullable<Project['nodes'][number]['security']>;
const withSec = (nodes: Record<string, Sec>, edges: Record<string, NonNullable<Project['edges'][number]['security']>> = {}, p: Project = ledger): Project => ({
  ...p,
  nodes: p.nodes.map((n) => (nodes[n.id] ? { ...n, security: nodes[n.id] } : n)),
  edges: p.edges.map((e) => (edges[`${e.from}>${e.to}`] ? { ...e, security: edges[`${e.from}>${e.to}`] } : e)),
});
// 다 정해 둔 안전한 설정 (여기서 하나씩 바꿔 본다)
const safe: Record<string, Sec> = {
  'U-01': { secrets: 'none' },
  'B-01': { exposure: 'public', tls: true, secrets: 'manager', waf: true, rate_limit: true },
  'D-01': { exposure: 'private', tls: true, at_rest: true, tenant_isolation: 'rls' },
  'J-01': { exposure: 'internal', secrets: 'env' },
};
const safeEdges = { 'U-01>B-01': { tls: 'tls' as const }, 'J-01>B-01': { tls: 'tls' as const }, 'B-01>D-01': { tls: 'tls' as const }, 'B-01>X-01': { tls: 'tls' as const } };
// 장부 예시의 FastAPI(aws)와 Supabase(supabase)는 다른 클라우드라 그 연결선에 늘 ℹ️가 붙는다 → 점검 결과 비교에서는 뺌
const ids = (p: Project) => checkSecurity(p).filter((h) => h.ruleId !== 'sec_cross_cloud').map((h) => `${h.level}:${h.ruleId}:${h.node ?? h.edge!.join('>')}`);

describe('네트워크·보안 점검', () => {
  it('다 정하고 안전하면 아무것도 없음', () => {
    expect(ids(withSec(safe, safeEdges))).toEqual([]);
  });

  it('비어 있으면 노드·연결선마다 "미정" 한 줄 (레이어에 맞는 칸만)', () => {
    const hits = checkSecurity(ledger);
    expect(hits.filter((h) => h.ruleId === 'sec_unset').map((h) => [h.node, h.why])).toEqual([
      ['U-01', '보안 값 미정: 비밀 보관'],
      ['B-01', '보안 값 미정: 공개 범위·TLS·비밀 보관'],
      ['D-01', '보안 값 미정: 공개 범위·TLS·저장 암호화·테넌트 분리'],
      ['J-01', '보안 값 미정: 공개 범위·비밀 보관'],
    ]);
    // 외부 서비스(X-01)는 우리가 정할 칸이 없음. 연결선은 모두 미정, 지나는 망을 짐작할 수 없는 선은 망도 미정
    expect(hits.filter((h) => h.ruleId === 'sec_edge_unset').map((h) => [h.edge!.join('>'), h.why])).toEqual([
      ['U-01>B-01', '보안 값 미정: 암호화'],
      ['J-01>B-01', '보안 값 미정: 암호화·지나는 망'],
      ['B-01>D-01', '보안 값 미정: 암호화'],
      ['B-01>X-01', '보안 값 미정: 암호화'],
    ]);
    expect(hits.filter((h) => h.level !== 'info').every((h) => h.level === 'conditional')).toBe(true);
    // AWS의 FastAPI ↔ Supabase는 인터넷을 지나는 다른 클라우드 연결 (ℹ️)
    expect(hits.filter((h) => h.level === 'info').map((h) => [h.ruleId, h.edge!.join('>')])).toEqual([['sec_cross_cloud', 'B-01>D-01']]);
  });

  it('❌ DB 인터넷 공개, 인터넷 연결선 암호화 없음, 개인정보 저장 암호화 없음', () => {
    const p = withSec({ ...safe, 'D-01': { exposure: 'public', tls: true, at_rest: false, tenant_isolation: 'rls' } }, { ...safeEdges, 'U-01>B-01': { tls: 'none' } });
    const q = { ...p, nodes: p.nodes.map((n) => (n.id === 'D-01' ? { ...n, privacy: { personal: true, sensitive: false, unique_id: false, subjects: ['KR'], sends_external: false } } : n)) };
    expect(ids(q)).toEqual([
      'fail:sec_store_public:D-01', 'fail:sec_personal_plain:D-01', 'conditional:sec_unset:D-01',
      'fail:sec_plain_internet:U-01>B-01',
    ]);
    // 개인정보 노드는 감사 로그도 정해야 함 (미정 줄에 들어감)
    expect(checkSecurity(q).find((h) => h.ruleId === 'sec_unset')!.why).toBe('보안 값 미정: 감사 로그');
  });

  it('⚠️ 공개 백엔드에 WAF·속도 제한 없음 (속도 제한 항목을 고르면 충족), 화면에 비밀, 인증 없는 쓰기 API', () => {
    const p = withSec({ ...safe, 'B-01': { ...safe['B-01'], waf: false, rate_limit: false }, 'U-01': { secrets: 'env' } }, safeEdges);
    expect(ids(p)).toEqual(['conditional:sec_client_secret:U-01', 'conditional:sec_public_unguarded:B-01']);
    expect(checkSecurity(p).find((h) => h.ruleId === 'sec_public_unguarded')!.why).toContain('WAF·속도 제한');
    const limited = { ...p, nodes: p.nodes.map((n) => (n.id === 'B-01' ? { ...n, extras: [...n.extras, 'token_bucket'] } : n)) };
    expect(checkSecurity(limited).find((h) => h.ruleId === 'sec_public_unguarded')!.why).not.toContain('속도 제한');
    const open = { ...p, edges: p.edges.map((e) => (e.from === 'U-01' ? { ...e, interfaces: e.interfaces.map((i) => (i.method === 'POST' ? { ...i, auth: 'none' as const } : i)) } : e)) };
    expect(checkSecurity(open).filter((h) => h.ruleId === 'sec_open_write').map((h) => h.why.split('(')[0])).toEqual(['POST /api/sales', 'POST /api/receipts']);
  });

  it('⚠️ 고객 구분 컬럼(store_id)이 있는데 테넌트 분리 없음, 정하지 않았으면 미정, ℹ️ 같은 클라우드에서 리전을 넘는 연결', () => {
    const p = withSec({ ...safe, 'D-01': { ...safe['D-01'], tenant_isolation: 'none' } }, safeEdges);
    expect(ids(p)).toEqual(['conditional:sec_tenant_mixed:D-01']);
    const { tenant_isolation: _t, ...noTenant } = safe['D-01'];
    expect(checkSecurity(withSec({ ...safe, 'D-01': noTenant }, safeEdges)).find((h) => h.ruleId === 'sec_unset')!.why).toBe('보안 값 미정: 테넌트 분리');
    const far = { ...p, nodes: p.nodes.map((n) => (n.id === 'D-01' ? { ...n, region: 'aws:ap-northeast-1' as const } : n)) };
    expect(checkSecurity(far).filter((h) => h.level === 'info').map((h) => [h.ruleId, h.edge!.join('>')])).toEqual([['sec_cross_region', 'B-01>D-01']]);
  });

  it('지나는 망: 적은 값이 먼저, 없으면 화면·외부 서비스와 잇는 선만 인터넷', () => {
    const e = (from: string, to: string) => ledger.edges.find((x) => x.from === from && x.to === to)!;
    // B-01(aws) → D-01(supabase)은 다른 클라우드라 인터넷, J-01(리전 없음 = 프로젝트 기본 aws) → B-01은 모름
    expect([edgeNet(ledger, e('U-01', 'B-01')), edgeNet(ledger, e('B-01', 'X-01')), edgeNet(ledger, e('B-01', 'D-01')), edgeNet(ledger, e('J-01', 'B-01'))]).toEqual(['internet', 'internet', 'internet', undefined]);
    expect(edgeNet(ledger, { ...e('U-01', 'B-01'), security: { crosses: 'internal' } })).toBe('internal');
  });
});
