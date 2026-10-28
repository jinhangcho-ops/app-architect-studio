import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCatalog, loadProject } from '../io';
import type { Project } from '../schema';
import { checkSecurity, edgeNet, fieldText, hasExposure, relevant, stride } from '../security';

const root = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const catalog = loadCatalog(root('data/catalog'));
// 장부 앱: PWA(U-01) → FastAPI(B-01) → Supabase(D-01), FastAPI → Google Vision(X-01), 크론(J-01) → FastAPI
const example = loadProject(root('examples/ledger-fastapi.json'), catalog.items);
const ledger: Project = { ...example, nodes: example.nodes.map(({ security: _, ...n }) => n), edges: example.edges.map(({ security: _, ...e }) => e) };

type Sec = NonNullable<Project['nodes'][number]['security']>;
// 다 정해 둔 안전한 인증·인가 (인증·인가 시험에서 하나씩 바꿔 본다)
const safeAuth: NonNullable<Project['auth']> = { method: 'jwt', issuer: 'B-01', token_ttl_min: 60, refresh: true, mfa: 'required', roles: 'rbac', admin_separate: true, service_auth: 'mtls' };
const withSec = (nodes: Record<string, Sec>, edges: Record<string, NonNullable<Project['edges'][number]['security']>> = {}, p: Project = { ...ledger, auth: safeAuth }): Project => ({
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
const ids = (p: Project) => checkSecurity(p).filter((h) => h.ruleId !== 'sec_cross_cloud').map((h) => `${h.level}:${h.ruleId}:${h.node ?? h.edge?.join('>') ?? h.target}`);

describe('네트워크·보안 점검', () => {
  it('예시 장부 앱: 정해 둔 값은 미정에서 빠지고, 인터넷 공개 API의 WAF 끔이 ⚠️로 보임, 인증 방식 미정', () => {
    expect(ids(example)).toEqual([
      'conditional:sec_public_unguarded:B-01', 'conditional:sec_unset:D-01', 'conditional:sec_unset:J-01', 'conditional:sec_edge_unset:J-01>B-01',
      'conditional:sec_auth_unset:프로젝트',
    ]);
  });

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
    // 개인정보 DB(D-01)를 읽는 공개 API(B-01)도 감사 로그를 정해야 함
    expect(ids(q)).toEqual([
      'conditional:sec_unset:B-01', 'fail:sec_store_public:D-01', 'fail:sec_personal_plain:D-01', 'conditional:sec_unset:D-01',
      'fail:sec_plain_internet:U-01>B-01',
    ]);
    // 개인정보 노드는 감사 로그도 정해야 함 (미정 줄에 들어감)
    expect(checkSecurity(q).filter((h) => h.ruleId === 'sec_unset').map((h) => h.why)).toEqual(['보안 값 미정: 감사 로그', '보안 값 미정: 감사 로그']);
  });

  it('감사 로그: 개인정보 노드, 그리고 프로젝트에 개인정보 노드가 있을 때 공개 gateway·backend도 정할 칸', () => {
    const priv = (p: Project): Project => ({ ...p, nodes: p.nodes.map((n) => (n.id === 'D-01' ? { ...n, privacy: { personal: true, sensitive: false, unique_id: false, subjects: ['KR'], sends_external: false } } : n)) });
    const b = (p: Project) => p.nodes.find((n) => n.id === 'B-01')!;
    const p = withSec(safe, safeEdges);
    expect([relevant(p, b(p)).includes('audit_log'), fieldText(p, b(p), 'audit_log')]).toEqual([false, '—']);
    expect([relevant(priv(p), b(priv(p))).includes('audit_log'), fieldText(priv(p), b(priv(p)), 'audit_log')]).toEqual([true, '미정']);
    // 공개 API에서 끔이면 ⚠️, 문구는 공개 API용
    const off = priv(withSec({ ...safe, 'B-01': { ...safe['B-01'], audit_log: false } }, safeEdges));
    expect(checkSecurity(off).filter((h) => h.ruleId === 'sec_no_audit').map((h) => [h.node, h.why])).toEqual([
      ['B-01', '장부 API (FastAPI)이 개인정보를 읽고 쓰는 공개 API인데 감사 로그가 없어 누가 언제 열람·변경했는지 확인할 수 없습니다'],
    ]);
    // 개인정보가 없으면 공개 API의 감사 로그 끔은 그냥 둠
    expect(checkSecurity(withSec({ ...safe, 'B-01': { ...safe['B-01'], audit_log: false } }, safeEdges)).some((h) => h.ruleId === 'sec_no_audit')).toBe(false);
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

describe('인증·인가', () => {
  const withAuth = (auth: Project['auth'], p: Project = withSec(safe, safeEdges)): Project => ({ ...p, auth });
  const personal = (p: Project): Project => ({ ...p, nodes: p.nodes.map((n) => (n.id === 'D-01' ? { ...n, privacy: { personal: true, sensitive: false, unique_id: false, subjects: ['KR'], sends_external: false } } : n)) });
  const authHits = (p: Project) => checkSecurity(p).filter((h) => h.target === '프로젝트');
  const one = (p: Project, ruleId: string) => authHits(p).filter((h) => h.ruleId === ruleId).map((h) => [h.level, h.node, h.edge, h.why, h.instead]);

  it('인터넷 공개 gateway·backend가 없으면 인증·인가 규칙 없음', () => {
    const closed = withSec({ ...safe, 'B-01': { ...safe['B-01'], exposure: 'internal' } }, safeEdges);
    expect(authHits(withAuth(undefined, closed))).toEqual([]);
    expect(authHits(personal(withAuth({ method: 'none', token_ttl_min: 99999, mfa: 'none', roles: 'none', admin_separate: false, service_auth: 'none' }, closed)))).toEqual([]);
  });

  it('공개 서버가 없어도 화면이 외부 서비스를 바로 부르면(BaaS) 인증·인가 규칙이 돔', () => {
    const closed = withSec({ ...safe, 'B-01': { ...safe['B-01'], exposure: 'internal' } }, safeEdges);
    const baas = { ...closed, edges: [...closed.edges, { ...closed.edges[0], from: 'U-01', to: 'X-01', interfaces: [] }] };
    expect(authHits(withAuth(undefined, baas)).map((h) => h.ruleId)).toEqual(['sec_auth_unset']);
  });

  it('다 정하고 안전하면 없음', () => {
    expect(authHits(personal(withSec(safe, safeEdges)))).toEqual([]);
  });

  it('⚠️ sec_auth_unset: auth가 없거나 방식이 비면 (다른 칸 미정은 따로 내지 않음)', () => {
    const unset = [['conditional', undefined, undefined, '인증 방식 미정: 사용자가 어떻게 로그인하고 토큰이 몇 분 사는지가 설계에 없습니다', '설정 › 인증·인가에서 정하세요']];
    expect(one(withAuth(undefined), 'sec_auth_unset')).toEqual(unset);
    expect(authHits(withAuth({ mfa: 'required' })).map((h) => h.ruleId)).toEqual(['sec_auth_unset']);
  });

  it('⚠️ sec_auth_partial: 방식은 있는데 토큰 수명(토큰 방식만)·MFA·권한 모델·관리자 분리·서비스 간 인증 중 빈 칸', () => {
    expect(one(withAuth({ method: 'jwt' }), 'sec_auth_partial')).toEqual([['conditional', undefined, undefined, '인증·인가 값 미정: 토큰 수명·MFA·권한 모델·관리자 분리·서비스 간 인증', '설정 › 인증·인가에서 정하세요']]);
    expect(one(withAuth({ method: 'session' }), 'sec_auth_partial')[0][3]).toContain('토큰 수명');
    expect(one(withAuth({ method: 'api_key' }), 'sec_auth_partial')[0][3]).toBe('인증·인가 값 미정: MFA·권한 모델·관리자 분리·서비스 간 인증');
    expect(one(withAuth({ ...safeAuth, roles: undefined }), 'sec_auth_partial')[0][3]).toBe('인증·인가 값 미정: 권한 모델');
    // 인증 없음이면 MFA·관리자 분리는 묻지 않음
    expect(one(withAuth({ method: 'none' }), 'sec_auth_partial')[0][3]).toBe('인증·인가 값 미정: 권한 모델·서비스 간 인증');
  });

  it('⚠️ sec_auth_none: 인증 없음인데 공개 노드에 bearer·API 키가 아닌 쓰기 REST (POST 3개 중 bearer 1개 빼고 2개)', () => {
    expect(one(withAuth({ ...safeAuth, method: 'none' }), 'sec_auth_none')).toEqual([['conditional', undefined, undefined, '인증 없이 쓰기 API를 공개합니다 (2개)', '로그인 토큰이나 API 키를 요구하세요']]);
    expect(one(withAuth({ ...safeAuth, method: 'none' }), 'sec_auth_contradict')).toEqual([]);
  });

  it('⚠️ sec_auth_contradict: 인증 없음인데 쓰기 인터페이스는 모두 bearer·API 키', () => {
    const p = withAuth({ ...safeAuth, method: 'none' });
    const bearer = { ...p, edges: p.edges.map((e) => ({ ...e, interfaces: e.interfaces.map((i) => ({ ...i, auth: 'bearer' as const })) })) };
    expect(one(bearer, 'sec_auth_none')).toEqual([]);
    expect(one(bearer, 'sec_auth_contradict')).toEqual([['conditional', undefined, undefined, "인터페이스는 인증(bearer·API 키)을 요구하는데 프로젝트 인증 방식은 '없음'입니다 — 둘 중 하나가 틀림", '설정 › 인증·인가의 방식을 맞추세요']]);
  });

  it('⚠️ sec_token_long: jwt·oauth_oidc는 하루(갱신 토큰이 있어도), session은 7일을 넘고 갱신 없음, api_key는 보지 않음', () => {
    const long = (a: Partial<NonNullable<Project['auth']>>) => one(withAuth({ ...safeAuth, ...a }), 'sec_token_long');
    expect(long({ token_ttl_min: 2880, refresh: false })).toEqual([['conditional', undefined, undefined, '토큰 수명 2880분이 하루를 넘고 갱신 토큰이 없어, 새면 그 시간 동안 그대로 쓰입니다', '액세스 토큰은 60분 이하로 두고 갱신 토큰으로 이어 가세요']]);
    expect(long({ method: 'oauth_oidc', token_ttl_min: 1441, refresh: undefined })).toHaveLength(1);
    expect(long({ token_ttl_min: 43200, refresh: true })).toEqual([['conditional', undefined, undefined, '토큰 수명 43200분이 하루를 넘어, 새면 그 시간 동안 그대로 쓰입니다 (갱신 토큰이 있어도 액세스 토큰은 짧게)', '액세스 토큰은 60분 이하로 두고 갱신 토큰으로 이어 가세요']]);
    expect(long({ method: 'session', token_ttl_min: 20160, refresh: true })).toEqual([]);
    expect(long({ method: 'session', token_ttl_min: 20160, refresh: false })[0][3]).toContain('7일을 넘고');
    expect(long({ token_ttl_min: 1440, refresh: false })).toEqual([]);
    expect(long({ method: 'session', token_ttl_min: 2880, refresh: false })).toEqual([]);
    expect(long({ method: 'session', token_ttl_min: 20160, refresh: false })[0][3]).toContain('20160분');
    expect(long({ method: 'api_key', token_ttl_min: 99999, refresh: false })).toEqual([]);
  });

  it('⚠️ sec_no_mfa_admin·sec_admin_mixed: 개인정보 노드나 고객 구분 컬럼(store_id)이 있을 때만', () => {
    const p = withAuth({ ...safeAuth, mfa: 'none', admin_separate: false });
    const noTables = { ...p, nodes: p.nodes.map((n) => ({ ...n, tables: [] })) };
    expect(authHits(noTables)).toEqual([]);
    expect(authHits(p).map((h) => h.ruleId)).toEqual(['sec_no_mfa_admin', 'sec_admin_mixed']);
    expect(one(personal(noTables), 'sec_no_mfa_admin')).toHaveLength(1);
    expect(one(personal(p), 'sec_no_mfa_admin')).toEqual([['conditional', undefined, undefined, '개인정보나 여러 고객 데이터를 다루는데 MFA가 없어 비밀번호가 새면 바로 로그인됩니다', '관리자부터 MFA를 필수로 두세요']]);
    expect(one(personal(p), 'sec_admin_mixed')).toEqual([['conditional', undefined, undefined, '관리자 기능이 일반 화면·API와 섞여 있어 권한 검사 하나를 빠뜨리면 바로 노출됩니다', '관리자 화면·API를 따로 두고 따로 인증(MFA·IP 제한)하세요']]);
  });

  it('⚠️ sec_no_roles: 고객 구분 컬럼(store_id) 또는 개인정보가 있을 때', () => {
    const p = withAuth({ ...safeAuth, roles: 'none' });
    expect(one(p, 'sec_no_roles')).toEqual([['conditional', undefined, undefined, '권한 모델 없이 모든 로그인 사용자가 같은 권한입니다', '역할(RBAC)을 두고 관리자 기능·다른 고객 데이터는 역할로 막으세요']]);
    const noTables = { ...p, nodes: p.nodes.map((n) => ({ ...n, tables: [] })) };
    expect(one(noTables, 'sec_no_roles')).toEqual([]);
    expect(one(personal(noTables), 'sec_no_roles')).toHaveLength(1);
  });

  it('ℹ️ sec_service_auth_none: 서버 노드(화면·외부 제외)가 2개 이상', () => {
    const p = withAuth({ ...safeAuth, service_auth: 'none' });
    expect(one(p, 'sec_service_auth_none')).toEqual([['info', undefined, undefined, '서비스끼리 인증이 없어 한 서버가 뚫리면 다른 서비스를 그대로 부를 수 있습니다(측면 이동)', '내부망이라도 mTLS나 서비스 계정 키를 두세요']]);
    const single = { ...p, nodes: p.nodes.filter((n) => n.id === 'B-01' || !hasExposure(n)) };
    expect(one(single, 'sec_service_auth_none')).toEqual([]);
    // 백엔드 + DB만: 저장 노드는 세지 않음
    const withDb = { ...p, nodes: p.nodes.filter((n) => n.id !== 'J-01') };
    expect(one(withDb, 'sec_service_auth_none')).toEqual([]);
  });

  it('STRIDE가 점검 결과와 어긋나지 않음 (리뷰 사례 6·7·8·9)', () => {
    const b = (p: Project) => stride(p, p.nodes.find((n) => n.id === 'B-01')!).map((r) => r[2]);
    // 6. 위장: 토큰이 너무 길거나, 개인정보·고객 데이터가 있는데 MFA 없음이면 warn
    const s6 = personal(withAuth({ ...safeAuth, method: 'session', token_ttl_min: 99999, refresh: false, mfa: 'none' }));
    expect(authHits(s6).map((h) => h.ruleId)).toEqual(expect.arrayContaining(['sec_token_long', 'sec_no_mfa_admin']));
    expect(b(s6)[0]).toBe('warn');
    expect(b(withAuth({ ...safeAuth, token_ttl_min: 2880 }))[0]).toBe('warn');
    expect(b(withAuth({ ...safeAuth, mfa: 'none' }))[0]).toBe('warn');
    // 7. 권한 상승: 저장 노드에 고객 구분 컬럼이 있는데 테넌트 분리 없음이면 warn
    const s7 = withSec({ ...safe, 'D-01': { ...safe['D-01'], tenant_isolation: 'none' } }, safeEdges);
    expect(checkSecurity(s7).some((h) => h.ruleId === 'sec_tenant_mixed')).toBe(true);
    expect(b(s7)[5]).toBe('warn');
    // 8. 권한 상승: 관리자 분리가 비면 역할이 있어도 unset
    const s8 = withAuth({ ...safeAuth, admin_separate: undefined });
    expect(one(s8, 'sec_auth_partial')[0][3]).toContain('관리자 분리');
    expect(b(s8)[5]).toBe('unset');
    // 9. 부인: 공개 API 자신이 아니라 프로젝트에 개인정보 노드(D-01)가 있으면 감사 로그를 봄
    const s9 = personal(withSec(safe, safeEdges));
    const r9 = stride(s9, s9.nodes.find((n) => n.id === 'B-01')!)[2];
    expect([r9[2], r9[1]]).toEqual(['unset', '누가 언제 무엇을 했는지 남기는지 (감사 로그 미정)']);
  });

  it('STRIDE 상태: 다 정하면 모두 ok, 위장·권한 상승은 인증·인가 값으로 바뀜', () => {
    const b = (p: Project) => stride(p, p.nodes.find((n) => n.id === 'B-01')!);
    const ok = b(withSec(safe, safeEdges));
    expect(ok.map((r) => r[2])).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
    expect(ok[0][1]).toContain('(JWT(자체 발급) · MFA 필수)');
    expect(ok[2][1]).toContain('해당 없음');
    expect(ok[5][1]).toContain('역할 기반(RBAC)');
    const state = (auth: Project['auth']) => { const r = b(withAuth(auth)); return [r[0][2], r[5][2]]; };
    expect(state(undefined)).toEqual(['unset', 'unset']);
    expect(state({ ...safeAuth, method: 'none', roles: 'none' })).toEqual(['warn', 'warn']);
    expect(state({ ...safeAuth, admin_separate: false })).toEqual(['ok', 'warn']);
    expect(state({ ...safeAuth, admin_separate: undefined })).toEqual(['ok', 'unset']);
    // 인증 없는 인터페이스가 있으면 방식과 상관없이 위장 warn
    const p = withSec(safe, safeEdges);
    const open = { ...p, edges: p.edges.map((e) => (e.from === 'U-01' ? { ...e, interfaces: e.interfaces.map((i) => ({ ...i, auth: 'none' as const })) } : e)) };
    expect(b(open)[0][2]).toBe('warn');
    // 다른 줄: 값 끔 → warn, 비면 unset
    const off = b(withSec({ ...safe, 'B-01': { exposure: 'public', tls: false, waf: false, rate_limit: true } }, safeEdges));
    expect(off.map((r) => r[2])).toEqual(['ok', 'warn', 'ok', 'unset', 'warn', 'ok']);
    const blank = b(withSec({ ...safe, 'B-01': { exposure: 'public' } }, safeEdges));
    expect(blank.map((r) => r[2])).toEqual(['ok', 'unset', 'ok', 'unset', 'unset', 'ok']);
    // 부인: 개인정보 노드는 감사 로그 값을 봄
    const priv = (audit_log?: boolean) => {
      const q = withSec({ ...safe, 'B-01': { ...safe['B-01'], audit_log } }, safeEdges);
      return b({ ...q, nodes: q.nodes.map((n) => (n.id === 'B-01' ? { ...n, privacy: { personal: true, sensitive: false, unique_id: false, subjects: ['KR'], sends_external: false } } : n)) })[2][2];
    };
    expect([priv(true), priv(false), priv(undefined)]).toEqual(['ok', 'warn', 'unset']);
  });
});

describe('속도 제한 기준치(rate_limit_rpm)를 트래픽과 대조', () => {
  // B-01 이벤트 피크 10 RPS, 동시 접속 100명 → 바쁜 1분 = 10/100×60×3 = 18/분, 피크 전체 = 600/분
  const ctx = { nodeEventRps: (id: string): number | undefined => (id === 'B-01' ? 10 : undefined), concurrentEvent: 100 };
  const rpm = (n: number, extra: Sec = {}) => withSec({ ...safe, 'B-01': { ...safe['B-01'], rate_limit_rpm: n, ...extra } }, safeEdges);
  const rateHits = (p: Project, c?: typeof ctx) => checkSecurity(p, c).filter((h) => h.ruleId.startsWith('sec_rate_limit'));

  it('⚠️ 바쁜 1분보다 낮음, ℹ️ 피크 전체 이상, 사이 값은 없음', () => {
    expect(rateHits(rpm(10), ctx).map((h) => [h.level, h.ruleId, h.node, h.why, h.instead])).toEqual([[
      'conditional', 'sec_rate_limit_low', 'B-01',
      '속도 제한 10/분이 정상 사용자의 바쁜 1분(약 18/분)보다 낮아 정상 사용자를 차단합니다',
      '18/분 이상으로 올리거나, IP 대신 사용자(토큰) 단위로 세세요 (한 IP 뒤에 여러 사용자가 있음)',
    ]]);
    expect(rateHits(rpm(600), ctx).map((h) => [h.level, h.ruleId, h.why, h.instead])).toEqual([[
      'info', 'sec_rate_limit_loose', '한 클라이언트가 이벤트 피크 전체(600/분)만큼 보내도 막히지 않아 효과가 적습니다', '피크의 몇 분의 일로 낮추세요',
    ]]);
    expect(rateHits(rpm(100), ctx)).toEqual([]);
    expect(rateHits(rpm(18), ctx)).toEqual([]);
  });

  it('ctx가 없거나 동시 접속이 0이면 대조하지 않음', () => {
    expect(rateHits(rpm(10))).toEqual([]);
    expect(rateHits(rpm(600))).toEqual([]);
    expect(rateHits(rpm(10), { ...ctx, concurrentEvent: 0 })).toEqual([]);
  });

  it('사용자가 매우 적어 바쁜 1분이 피크 전체 이상이거나 트래픽이 0이면 대조하지 않음', () => {
    // 동시 접속 2명: 바쁜 1분 = 10/2×60×3 = 900/분 ≥ 피크 전체 600/분
    expect(rateHits(rpm(10), { ...ctx, concurrentEvent: 2 })).toEqual([]);
    expect(rateHits(rpm(600), { ...ctx, concurrentEvent: 2 })).toEqual([]);
    expect(rateHits(rpm(10), { ...ctx, nodeEventRps: () => 0 })).toEqual([]);
    expect(rateHits(rpm(0), { ...ctx, nodeEventRps: () => 0 })).toEqual([]);
  });

  it('바쁜 1분은 올림해서 보임: 한도가 올림값과 같으면 ⚠️ 없음, 낮으면 올림값을 안내', () => {
    const c = { nodeEventRps: () => 103, concurrentEvent: 1800 }; // 바쁜 1분 = 10.3/분
    expect(rateHits(rpm(11), c)).toEqual([]);
    const [h] = rateHits(rpm(10), c);
    expect(h.why).toContain('약 11/분');
    expect(h.instead).toContain('11/분 이상');
  });

  it('값이 있으면 속도 제한은 켬: 공개 무방비·미정에 속도 제한이 빠지고, 칸 글자는 "켬 (600/분)"', () => {
    const off = rpm(100, { waf: false, rate_limit: false });
    expect(checkSecurity(off, ctx).find((h) => h.ruleId === 'sec_public_unguarded')!.why).not.toContain('속도 제한');
    const { rate_limit: _r, ...noFlag } = safe['B-01'];
    const unset = withSec({ ...safe, 'B-01': { ...noFlag, rate_limit_rpm: 100 } }, safeEdges);
    expect(checkSecurity(unset).filter((h) => h.ruleId === 'sec_unset' && h.why.includes('속도 제한'))).toEqual([]);
    const q = rpm(600, { rate_limit: false });
    expect(fieldText(q, q.nodes.find((n) => n.id === 'B-01')!, 'rate_limit')).toBe('켬 (600/분)');
  });
});
