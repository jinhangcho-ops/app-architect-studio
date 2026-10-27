// 네트워크·보안 점검 (v1.4.0): 노드·연결선의 보안 값과 구조로 ❌(막아야 함)·⚠️(확인 필요)·ℹ️(알아 둘 것)을 낸다.
// 비어 있는 값은 "미정"으로 노드·연결선마다 한 줄로 묶어 ⚠️ (사용자 결정: 비면 모두 확인 필요). 기존 항목 판정(judgements)과 따로 낸다.
import type { Layer } from './model';
import { itemIds, nodeRegion, type Project, type ProjectNode } from './schema';

export type SecurityLevel = 'fail' | 'conditional' | 'info';
export type SecurityHit = {
  ruleId: string;
  level: SecurityLevel;
  /** 걸린 노드 id 또는 연결선 [보내는, 받는] */
  node?: string;
  edge?: [string, string];
  /** 사람이 읽는 대상 (노드 이름 또는 "보내는 → 받는") */
  target: string;
  why: string;
  instead: string;
};

type Field = keyof NonNullable<ProjectNode['security']>;
export const SECURITY_FIELD_NAMES: Record<Field, string> = {
  exposure: '공개 범위', tls: 'TLS', at_rest: '저장 암호화', secrets: '비밀 보관',
  waf: 'WAF', rate_limit: '속도 제한', audit_log: '감사 로그', tenant_isolation: '테넌트 분리',
};

const STORE: Layer[] = ['db', 'cache', 'queue', 'analytics'];
// 여러 고객(매장·회사·조직)의 데이터가 한 테이블에 섞이는 표시가 되는 컬럼
const TENANT_KEY = /^(tenant|store|restaurant|shop|merchant|org|organization|company|account|workspace|team)_id$/;
// 속도 제한을 대신하는 카탈로그 항목 (API 게이트웨이·속도 제한 패턴)
const RATE_LIMITERS = new Set(['token_bucket', 'kong']);

const hasTenantKey = (n: ProjectNode) => n.tables.some((t) => t.columns.some((c) => TENANT_KEY.test(c.name)));

/** 이 노드에서 정해야 하는 보안 칸 (레이어·공개 범위·개인정보·테이블에 따라) */
function relevant(n: ProjectNode): Field[] {
  const s = n.security ?? {};
  const personal = !!n.privacy?.personal;
  const fields: Field[] =
    n.layer === 'external' ? []
    : n.layer === 'ui' ? ['secrets']
    : n.layer === 'batch' ? ['exposure', 'secrets']
    : STORE.includes(n.layer) ? ['exposure', 'tls', 'at_rest']
    : ['exposure', 'tls', 'secrets'];
  if (s.exposure === 'public' && (n.layer === 'gateway' || n.layer === 'backend')) fields.push('waf', 'rate_limit');
  if (STORE.includes(n.layer) && hasTenantKey(n)) fields.push('tenant_isolation');
  if (personal && n.layer !== 'external' && n.layer !== 'ui') fields.push('audit_log');
  return fields;
}

/** 두 노드가 둔 클라우드 (리전 "aws:ap-northeast-2"의 앞부분). 사용자 기기·리전 없음은 undefined */
const cloudOf = (p: Project, n?: ProjectNode) => { const r = n && nodeRegion(n, p); return r && r !== 'local' ? r.split(':')[0] : undefined; };

/** 연결선이 지나는 망: 적은 값, 없으면 화면(사용자 기기)·외부 서비스와 잇는 선, 서로 다른 클라우드(AWS ↔ Supabase 등) 사이는 인터넷 */
export const edgeNet = (p: Project, e: Project['edges'][number]) => {
  if (e.security?.crosses) return e.security.crosses;
  const from = p.nodes.find((n) => n.id === e.from), to = p.nodes.find((n) => n.id === e.to);
  if ([from?.layer, to?.layer].some((l) => l === 'ui' || l === 'external')) return 'internet';
  const a = cloudOf(p, from), b = cloudOf(p, to);
  return a && b && a !== b ? 'internet' : undefined;
};

export function checkSecurity(p: Project): SecurityHit[] {
  const hits: SecurityHit[] = [];
  const nameOf = (id: string) => p.nodes.find((n) => n.id === id)?.name ?? id;
  for (const n of p.nodes) {
    const s = n.security ?? {};
    const at = { node: n.id, target: n.name };
    // 1. 데이터를 가진 노드가 인터넷에 열림
    if (STORE.includes(n.layer) && s.exposure === 'public') {
      hits.push({ ...at, ruleId: 'sec_store_public', level: 'fail', why: `${n.name}(데이터 저장)이 인터넷에 열려 있어 비밀번호 추측·알려진 취약점으로 데이터를 통째로 잃을 수 있습니다`, instead: '사설·내부망에 두고 백엔드만 접속하게 하세요 (보안 그룹·방화벽으로 백엔드 주소만 허용)' });
    }
    // 3. 개인정보를 저장하는데 저장 암호화 없음
    if (n.privacy?.personal && STORE.includes(n.layer) && s.at_rest === false) {
      hits.push({ ...at, ruleId: 'sec_personal_plain', level: 'fail', why: `${n.name}에 개인정보가 있는데 저장 암호화가 꺼져 있어 디스크·백업이 새면 그대로 읽힙니다`, instead: 'DB·디스크 암호화를 켜고(대부분의 관리형 DB는 기본값), 민감 컬럼은 따로 암호화하세요' });
    }
    // 4. 인터넷 공개 백엔드·게이트웨이에 WAF·속도 제한 없음
    if (s.exposure === 'public' && (n.layer === 'gateway' || n.layer === 'backend')) {
      const missing = [...(s.waf === false ? ['WAF'] : []), ...(s.rate_limit === false && !itemIds(n).some((id) => RATE_LIMITERS.has(id)) ? ['속도 제한'] : [])];
      if (missing.length) hits.push({ ...at, ruleId: 'sec_public_unguarded', level: 'conditional', why: `${n.name}이 인터넷에 열려 있는데 ${missing.join('·')}이 없어 대량 요청·알려진 공격 패턴을 그대로 받습니다`, instead: '앞에 WAF(CDN·클라우드 WAF)와 사용자·IP별 속도 제한을 두세요' });
    }
    // 6. 화면(사용자 기기)에 비밀을 둠
    if (n.layer === 'ui' && (s.secrets === 'env' || s.secrets === 'manager')) {
      hits.push({ ...at, ruleId: 'sec_client_secret', level: 'conditional', why: `${n.name}은 사용자 기기에서 돌아 번들·앱 안의 키가 그대로 공개됩니다 (PWA·SPA는 코드를 누구나 받음)`, instead: '서비스 키는 백엔드에만 두고, 화면은 로그인 토큰과 공개용 키(anon key 등)만 쓰세요' });
    }
    // 7. 여러 고객 데이터가 섞이는데 분리 없음
    if (STORE.includes(n.layer) && hasTenantKey(n) && s.tenant_isolation === 'none') {
      hits.push({ ...at, ruleId: 'sec_tenant_mixed', level: 'conditional', why: `${n.name}의 테이블에 고객(매장·회사) 구분 컬럼이 있는데 분리 방법이 없어, 조건 하나를 빠뜨리면 다른 고객 데이터가 보입니다`, instead: 'DB 행 권한(RLS)이나 모든 쿼리에 고객 조건을 강제하는 계층을 두세요' });
    }
    // 8. 개인정보 노드에 감사 로그 없음
    if (n.privacy?.personal && s.audit_log === false) {
      hits.push({ ...at, ruleId: 'sec_no_audit', level: 'conditional', why: `${n.name}이 개인정보를 다루는데 감사 로그가 없어 누가 언제 열람·변경했는지 확인할 수 없습니다`, instead: '개인정보 열람·변경·내보내기를 누가·언제·무엇을 남기는 로그로 남기세요 (개인정보 보호법의 접속기록 보관과 연결)' });
    }
    // 미정: 이 노드에서 정해야 하는 칸 중 비어 있는 것
    const unset = relevant(n).filter((f) => s[f] === undefined && !(f === 'rate_limit' && itemIds(n).some((id) => RATE_LIMITERS.has(id))));
    if (unset.length) hits.push({ ...at, ruleId: 'sec_unset', level: 'conditional', why: `보안 값 미정: ${unset.map((f) => SECURITY_FIELD_NAMES[f]).join('·')}`, instead: '노드 패널 › 네트워크·보안에서 정하세요' });
  }

  for (const e of p.edges) {
    const target = `${nameOf(e.from)} → ${nameOf(e.to)}`, at = { edge: [e.from, e.to] as [string, string], target };
    const net = edgeNet(p, e), tls = e.security?.tls;
    // 2. 인터넷을 지나는데 암호화 없음
    if (net === 'internet' && tls === 'none') {
      hits.push({ ...at, ruleId: 'sec_plain_internet', level: 'fail', why: `${target} 연결이 인터넷을 지나는데 암호화하지 않아 중간에서 토큰·데이터를 엿보거나 바꿀 수 있습니다`, instead: 'HTTPS(TLS)로 바꾸세요. 서비스끼리는 mTLS로 서로를 확인할 수 있습니다' });
    }
    if (tls === undefined) hits.push({ ...at, ruleId: 'sec_edge_unset', level: 'conditional', why: `보안 값 미정: 암호화${net ? '' : '·지나는 망'}`, instead: '연결선 패널 › 네트워크·보안에서 정하세요' });
    // 5. 인증 없는 쓰기 API
    for (const i of e.interfaces) {
      if (i.kind === 'rest' && i.auth === 'none' && i.method && i.method !== 'GET') {
        hits.push({ ...at, ruleId: 'sec_open_write', level: 'conditional', why: `${i.method} ${i.path}(${i.name})를 인증 없이 부를 수 있어 누구나 데이터를 바꿀 수 있습니다`, instead: '로그인 토큰(bearer)이나 서비스 키(api_key)를 요구하세요. 정말 공개라면 속도 제한과 입력 검증을 두세요' });
      }
    }
    // 9. 클라우드·리전을 넘는 연결
    const from = p.nodes.find((n) => n.id === e.from), to = p.nodes.find((n) => n.id === e.to);
    if (from && to && ![from.layer, to.layer].some((l) => l === 'ui' || l === 'external')) {
      const a = nodeRegion(from, p), b = nodeRegion(to, p);
      if (a && b && a !== 'local' && b !== 'local' && a !== b) {
        hits.push(cloudOf(p, from) !== cloudOf(p, to)
          ? { ...at, ruleId: 'sec_cross_cloud', level: 'info', why: `${target}은 서로 다른 클라우드 사이 연결입니다 (${a} → ${b}): 사설망이 아니라 인터넷을 지나므로 암호화가 꼭 필요하고, 송신 비용·지연이 붙습니다`, instead: '반드시 TLS로 잇고, 접속을 허용할 주소를 좁히세요 (DB면 연결 풀러·IP 허용 목록)' }
          : { ...at, ruleId: 'sec_cross_region', level: 'info', why: `${target}이 리전을 넘습니다 (${a} → ${b}): 왕복 지연·리전 간 송신 비용이 붙고, 개인정보면 국외 이전 조문을 확인해야 합니다`, instead: '같은 리전에 두거나, 넘는다면 암호화·지연·비용을 설계에 넣으세요' });
      }
    }
  }
  return hits;
}
