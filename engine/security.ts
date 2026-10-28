// 네트워크·보안 점검 (v1.3.0): 노드·연결선의 보안 값과 구조로 ❌(막아야 함)·⚠️(확인 필요)·ℹ️(알아 둘 것)을 낸다.
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

// rate_limit_rpm은 rate_limit 칸의 한도 값이라 따로 칸으로 세지 않음
type Field = Exclude<keyof NonNullable<ProjectNode['security']>, 'rate_limit_rpm'>;
/** 트래픽과 대조할 때 쓰는 값 (analyze가 채움): 노드 이벤트 피크 RPS, 이벤트 피크 동시 접속자 */
export type SecurityCtx = { nodeEventRps: (id: string) => number | undefined; concurrentEvent: number };
export const SECURITY_FIELD_NAMES: Record<Field, string> = {
  exposure: '공개 범위', tls: 'TLS', at_rest: '저장 암호화', secrets: '비밀 보관',
  waf: 'WAF', rate_limit: '속도 제한', audit_log: '감사 로그', tenant_isolation: '테넌트 분리',
};

export const EXPOSURE_NAMES = { public: '인터넷 공개', internal: '내부망만', private: '사설 (같은 서버·구역)' } as const;
export const SECRET_NAMES = { none: '쓰지 않음', env: '환경 변수·설정 파일', manager: '비밀 관리 서비스' } as const;
export const TENANT_NAMES = { none: '나누지 않음', app: '앱 코드가 조건을 붙임', rls: 'DB 행 권한 (RLS)' } as const;
export const EDGE_TLS_NAMES = { none: '암호화 없음', tls: 'TLS (HTTPS)', mtls: 'mTLS (서로 확인)' } as const;
export const EDGE_NET_NAMES = { local: '같은 서버', internal: '내부망', internet: '인터넷' } as const;
export const LEVEL_MARK = { fail: '❌', conditional: '⚠️', info: 'ℹ️' } as const;
export const AUTH_METHOD_NAMES = { none: '없음(공개)', session: '세션 쿠키', jwt: 'JWT(자체 발급)', oauth_oidc: 'OAuth2 · OIDC(외부 발급)', api_key: 'API 키' } as const;
export const MFA_NAMES = { none: '없음', optional: '선택', required: '필수' } as const;
export const ROLE_NAMES = { none: '없음', rbac: '역할 기반(RBAC)', abac: '속성 기반(ABAC)' } as const;
export const SERVICE_AUTH_NAMES = { none: '없음', mtls: 'mTLS', service_account: '서비스 계정·키' } as const;
/** STRIDE 줄 상태: 값으로 막혀 있음 · 확인 필요 · 값이 비어 판단 못 함 */
export type StrideState = 'ok' | 'warn' | 'unset';
export const STRIDE_MARK: Record<StrideState, string> = { ok: '✅', warn: '⚠️', unset: '미정' };
/** 공개 범위를 정하는 노드 (사용자 기기·외부 서비스는 우리가 정하지 않음) */
export const hasExposure = (n: ProjectNode) => n.layer !== 'ui' && n.layer !== 'external';

const STORE: Layer[] = ['db', 'cache', 'queue', 'analytics'];
// 여러 고객(매장·회사·조직)의 데이터가 한 테이블에 섞이는 표시가 되는 컬럼
const TENANT_KEY = /^(tenant|store|restaurant|shop|merchant|org|organization|company|account|workspace|team)_id$/;
// 속도 제한을 대신하는 카탈로그 항목 (API 게이트웨이·속도 제한 패턴)
const RATE_LIMITERS = new Set(['token_bucket', 'kong']);

// 속도 제한이 있음: 한도 값(rate_limit_rpm)이 있거나 속도 제한 항목을 고름. 값은 rate_limit: false보다 이김
const rateLimited = (n: ProjectNode) => n.security?.rate_limit_rpm !== undefined || itemIds(n).some((id) => RATE_LIMITERS.has(id));
const hasTenantKey = (n: ProjectNode) => n.tables.some((t) => t.columns.some((c) => TENANT_KEY.test(c.name)));
/** 개인정보 노드나 고객 구분 컬럼이 있음 (MFA·권한 모델·관리자 분리를 따지는 조건) */
const guarded = (p: Project) => p.nodes.some((n) => n.privacy?.personal || hasTenantKey(n));
/** 토큰 수명이 너무 김 (sec_token_long·STRIDE 위장 공용): jwt·oauth_oidc는 하루, session은 7일. 갱신 토큰 면제는 session만 */
const tokenLong = (a: NonNullable<Project['auth']>) =>
  (a.token_ttl_min ?? 0) > (a.method === 'session' ? 10080 : a.method === 'jwt' || a.method === 'oauth_oidc' ? 1440 : Infinity) && !(a.method === 'session' && a.refresh === true);

export const SECURITY_FIELDS = Object.keys(SECURITY_FIELD_NAMES) as Field[];
/** 노드 보안 칸 하나를 글자로: 이 노드에서 정할 칸이 아니면 —, 비면 미정 */
export function fieldText(p: Project, n: ProjectNode, f: Field): string {
  if (!relevant(p, n).includes(f)) return '—';
  const v = n.security?.[f], rpm = n.security?.rate_limit_rpm;
  if (f === 'rate_limit' && rpm !== undefined) return `켬 (${rpm}/분)`;
  if (v === undefined) return f === 'rate_limit' && rateLimited(n) ? '켬 (항목)' : '미정';
  if (typeof v === 'boolean') return v ? '켬' : '끔';
  return ({ exposure: EXPOSURE_NAMES, secrets: SECRET_NAMES, tenant_isolation: TENANT_NAMES } as Record<string, Record<string, string>>)[f][v];
}

const state = (v?: boolean) => (v === undefined ? '미정' : v ? '켬' : '끔');
/** 켬 → ok, 끔 → warn, 비면 unset */
const flag = (v?: boolean): StrideState => (v === undefined ? 'unset' : v ? 'ok' : 'warn');

/** 프로젝트 인증·인가 값을 [칸 이름, 글자]로 (설계서 표·명령줄 한 줄). 비면 미정 */
export function authFields(p: Project): [string, string][] {
  const a = p.auth ?? {};
  const name = <K extends string>(names: Record<K, string>, v?: K) => (v === undefined ? '미정' : names[v]);
  return [
    ['방식', name(AUTH_METHOD_NAMES, a.method)],
    ['발급 노드', a.issuer ? p.nodes.find((n) => n.id === a.issuer)?.name ?? a.issuer : '미정'],
    ['토큰 수명', a.token_ttl_min === undefined ? '미정' : `${a.token_ttl_min}분`],
    ['갱신', state(a.refresh)],
    ['MFA', name(MFA_NAMES, a.mfa)],
    ['권한 모델', name(ROLE_NAMES, a.roles)],
    ['관리자 분리', state(a.admin_separate)],
    ['서비스 간 인증', name(SERVICE_AUTH_NAMES, a.service_auth)],
  ];
}

/** 인터넷 공개 노드의 위협 점검표 (STRIDE: 위장·변조·부인·정보 노출·서비스 거부·권한 상승). [이름, 문구, 상태]. 값으로 알 수 있는 것은 그 상태를 붙인다 */
export function stride(p: Project, n: ProjectNode): [string, string, StrideState][] {
  const s = n.security ?? {}, a = p.auth ?? {};
  const open = p.edges.filter((e) => e.to === n.id).flatMap((e) => e.interfaces).filter((i) => i.auth === 'none');
  // 공개 API가 개인정보 DB를 읽으므로 노드 자신이 아니라 프로젝트에 개인정보 노드가 있는지 본다
  const personal = p.nodes.some((x) => x.privacy?.personal);
  const tenantMixed = p.nodes.some((x) => STORE.includes(x.layer) && hasTenantKey(x) && x.security?.tenant_isolation === 'none');
  const rate = fieldText(p, n, 'rate_limit') === '—' ? state(s.rate_limit) : fieldText(p, n, 'rate_limit');
  const rateOn = s.rate_limit === true || rateLimited(n), rateOff = s.rate_limit === false && !rateLimited(n);
  const roles = a.roles === undefined ? '미정' : ROLE_NAMES[a.roles];
  return [
    open.length
      ? ['위장', `인증 없이 부를 수 있는 인터페이스 ${open.length}개 (${open.map((i) => i.name).join(', ')}): 정말 공개해도 되는지`, 'warn']
      : ['위장', `요청마다 로그인 토큰·서비스 키를 확인하는지 (${a.method ? AUTH_METHOD_NAMES[a.method] : '미정'} · MFA ${a.mfa ? MFA_NAMES[a.mfa] : '미정'})`,
        a.method === undefined ? 'unset' : a.method === 'none' || tokenLong(a) || (guarded(p) && a.mfa === 'none') ? 'warn' : 'ok'],
    ['변조', `입력을 검증하고, 받는 연결을 TLS로 받는지 (TLS ${state(s.tls)})`, flag(s.tls)],
    ['부인', `누가 언제 무엇을 했는지 남기는지 (감사 로그 ${personal || s.audit_log !== undefined ? state(s.audit_log) : '해당 없음'})`, personal ? flag(s.audit_log) : 'ok'],
    ['정보 노출', `오류 메시지·로그에 내부 주소·키·개인정보가 새지 않는지 (비밀 보관 ${s.secrets ? SECRET_NAMES[s.secrets] : '미정'})`, s.secrets ? 'ok' : 'unset'],
    ['서비스 거부', `대량 요청을 막는지 (WAF ${state(s.waf)} · 속도 제한 ${rate})`, s.waf === false || rateOff ? 'warn' : s.waf && rateOn ? 'ok' : 'unset'],
    ['권한 상승', `관리자 기능과 다른 고객(매장·회사) 데이터에 권한 검사를 하는지 (권한 모델 ${roles} · 관리자 분리 ${state(a.admin_separate)})`,
      a.roles === 'none' || a.admin_separate === false || tenantMixed ? 'warn' : a.roles && a.admin_separate !== undefined ? 'ok' : 'unset'],
  ];
}

/** 개인정보 노드는 아니지만 프로젝트의 개인정보를 읽고 쓰는 인터넷 공개 gateway·backend (STRIDE 부인 줄이 감사 로그를 묻는 노드) */
const personalApi = (p: Project, n: ProjectNode) =>
  !n.privacy?.personal && n.security?.exposure === 'public' && (n.layer === 'gateway' || n.layer === 'backend') && p.nodes.some((x) => x.privacy?.personal);

/** 이 노드에서 정해야 하는 보안 칸 (레이어·공개 범위·개인정보·테이블에 따라) */
export function relevant(p: Project, n: ProjectNode): Field[] {
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
  if ((personal && n.layer !== 'external' && n.layer !== 'ui') || personalApi(p, n)) fields.push('audit_log');
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

export function checkSecurity(p: Project, ctx?: SecurityCtx): SecurityHit[] {
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
      const missing = [...(s.waf === false ? ['WAF'] : []), ...(s.rate_limit === false && !rateLimited(n) ? ['속도 제한'] : [])];
      if (missing.length) hits.push({ ...at, ruleId: 'sec_public_unguarded', level: 'conditional', why: `${n.name}이 인터넷에 열려 있는데 ${missing.join('·')} 없이 대량 요청·알려진 공격 패턴을 그대로 받습니다`, instead: '앞에 WAF(CDN·클라우드 WAF)와 사용자·IP별 속도 제한을 두세요' });
      // 9. 속도 제한 기준치를 트래픽과 대조 (트래픽 계산 없음·동시 접속 0·트래픽 0·사용자가 너무 적어 바쁜 1분이 피크 전체 이상이면 건너뜀)
      // shortcut: 바쁜 1분을 평균의 3배로 봄, 와이어프레임 화면당 호출 수를 모으게 되면 그 값으로 바꾼다
      // shortcut: 노드에 오는 사용자가 아니라 전체 동시 접속으로 나눔, 노드별 동시 접속을 계산하게 되면 그 값으로
      const rpm = s.rate_limit_rpm, rps = ctx?.nodeEventRps(n.id) ?? 0;
      const busy = ctx && ctx.concurrentEvent > 0 ? (rps / ctx.concurrentEvent) * 60 * 3 : Infinity;
      if (rpm !== undefined && rps > 0 && busy < rps * 60) {
        if (rpm < busy) hits.push({ ...at, ruleId: 'sec_rate_limit_low', level: 'conditional', why: `속도 제한 ${rpm}/분이 정상 사용자의 바쁜 1분(약 ${Math.ceil(busy)}/분)보다 낮아 정상 사용자를 차단합니다`, instead: `${Math.ceil(busy)}/분 이상으로 올리거나, IP 대신 사용자(토큰) 단위로 세세요 (한 IP 뒤에 여러 사용자가 있음)` });
        else if (rpm >= rps * 60) hits.push({ ...at, ruleId: 'sec_rate_limit_loose', level: 'info', why: `한 클라이언트가 이벤트 피크 전체(${Math.round(rps * 60)}/분)만큼 보내도 막히지 않아 효과가 적습니다`, instead: '피크의 몇 분의 일로 낮추세요' });
      }
    }
    // 6. 화면(사용자 기기)에 비밀을 둠
    if (n.layer === 'ui' && (s.secrets === 'env' || s.secrets === 'manager')) {
      hits.push({ ...at, ruleId: 'sec_client_secret', level: 'conditional', why: `${n.name}은 사용자 기기에서 돌아 번들·앱 안의 키가 그대로 공개됩니다 (PWA·SPA는 코드를 누구나 받음)`, instead: '서비스 키는 백엔드에만 두고, 화면은 로그인 토큰과 공개용 키(anon key 등)만 쓰세요' });
    }
    // 7. 여러 고객 데이터가 섞이는데 분리 없음
    if (STORE.includes(n.layer) && hasTenantKey(n) && s.tenant_isolation === 'none') {
      hits.push({ ...at, ruleId: 'sec_tenant_mixed', level: 'conditional', why: `${n.name}의 테이블에 고객(매장·회사) 구분 컬럼이 있는데 분리 방법이 없어, 조건 하나를 빠뜨리면 다른 고객 데이터가 보입니다`, instead: 'DB 행 권한(RLS)이나 모든 쿼리에 고객 조건을 강제하는 계층을 두세요' });
    }
    // 8. 개인정보 노드(또는 개인정보를 읽고 쓰는 공개 API)에 감사 로그 없음
    if ((n.privacy?.personal || personalApi(p, n)) && s.audit_log === false) {
      hits.push({ ...at, ruleId: 'sec_no_audit', level: 'conditional', why: `${n.name}이 ${n.privacy?.personal ? '개인정보를 다루는데' : '개인정보를 읽고 쓰는 공개 API인데'} 감사 로그가 없어 누가 언제 열람·변경했는지 확인할 수 없습니다`, instead: '개인정보 열람·변경·내보내기를 누가·언제·무엇을 남기는 로그로 남기세요 (개인정보 보호법의 접속기록 보관과 연결)' });
    }
    // 미정: 이 노드에서 정해야 하는 칸 중 비어 있는 것
    const unset = relevant(p, n).filter((f) => s[f] === undefined && !(f === 'rate_limit' && rateLimited(n)));
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

  // 인증·인가 (프로젝트 단위): 인터넷 공개 gateway·backend가 있거나, 화면이 외부 서비스를 바로 부를 때(BaaS)만
  const pub = p.nodes.filter((n) => n.security?.exposure === 'public' && (n.layer === 'gateway' || n.layer === 'backend'));
  const layerOf = (id: string) => p.nodes.find((n) => n.id === id)?.layer;
  if (pub.length || p.edges.some((e) => layerOf(e.from) === 'ui' && layerOf(e.to) === 'external')) {
    const a = p.auth ?? {}, at = { target: '프로젝트' };
    const sensitive = guarded(p);
    if (!a.method) {
      hits.push({ ...at, ruleId: 'sec_auth_unset', level: 'conditional', why: '인증 방식 미정: 사용자가 어떻게 로그인하고 토큰이 몇 분 사는지가 설계에 없습니다', instead: '설정 › 인증·인가에서 정하세요' });
    } else {
      const token = a.method === 'jwt' || a.method === 'oauth_oidc' || a.method === 'session';
      const unset = ([['token_ttl_min', '토큰 수명'], ['mfa', 'MFA'], ['roles', '권한 모델'], ['admin_separate', '관리자 분리'], ['service_auth', '서비스 간 인증']] as const)
        .filter(([k]) => a[k] === undefined && (k !== 'token_ttl_min' || token) && !(a.method === 'none' && (k === 'mfa' || k === 'admin_separate')));
      if (unset.length) hits.push({ ...at, ruleId: 'sec_auth_partial', level: 'conditional', why: `인증·인가 값 미정: ${unset.map(([, l]) => l).join('·')}`, instead: '설정 › 인증·인가에서 정하세요' });
    }
    const writes = p.edges.filter((e) => pub.some((n) => n.id === e.to)).flatMap((e) => e.interfaces).filter((i) => i.kind === 'rest' && i.method && i.method !== 'GET');
    const openWrites = writes.filter((i) => i.auth !== 'bearer' && i.auth !== 'api_key');
    if (a.method === 'none' && openWrites.length) {
      hits.push({ ...at, ruleId: 'sec_auth_none', level: 'conditional', why: `인증 없이 쓰기 API를 공개합니다 (${openWrites.length}개)`, instead: '로그인 토큰이나 API 키를 요구하세요' });
    } else if (a.method === 'none' && writes.length) {
      hits.push({ ...at, ruleId: 'sec_auth_contradict', level: 'conditional', why: "인터페이스는 인증(bearer·API 키)을 요구하는데 프로젝트 인증 방식은 '없음'입니다 — 둘 중 하나가 틀림", instead: '설정 › 인증·인가의 방식을 맞추세요' });
    }
    if (tokenLong(a)) {
      const why = `토큰 수명 ${a.token_ttl_min}분이 ${a.method === 'session' ? '7일을' : '하루를'} ${a.refresh ? '넘어, 새면 그 시간 동안 그대로 쓰입니다 (갱신 토큰이 있어도 액세스 토큰은 짧게)' : '넘고 갱신 토큰이 없어, 새면 그 시간 동안 그대로 쓰입니다'}`;
      hits.push({ ...at, ruleId: 'sec_token_long', level: 'conditional', why, instead: '액세스 토큰은 60분 이하로 두고 갱신 토큰으로 이어 가세요' });
    }
    if (sensitive && a.mfa === 'none') {
      hits.push({ ...at, ruleId: 'sec_no_mfa_admin', level: 'conditional', why: '개인정보나 여러 고객 데이터를 다루는데 MFA가 없어 비밀번호가 새면 바로 로그인됩니다', instead: '관리자부터 MFA를 필수로 두세요' });
    }
    if (a.roles === 'none' && sensitive) {
      hits.push({ ...at, ruleId: 'sec_no_roles', level: 'conditional', why: '권한 모델 없이 모든 로그인 사용자가 같은 권한입니다', instead: '역할(RBAC)을 두고 관리자 기능·다른 고객 데이터는 역할로 막으세요' });
    }
    if (sensitive && a.admin_separate === false) {
      hits.push({ ...at, ruleId: 'sec_admin_mixed', level: 'conditional', why: '관리자 기능이 일반 화면·API와 섞여 있어 권한 검사 하나를 빠뜨리면 바로 노출됩니다', instead: '관리자 화면·API를 따로 두고 따로 인증(MFA·IP 제한)하세요' });
    }
    if (a.service_auth === 'none' && p.nodes.filter((n) => hasExposure(n) && !STORE.includes(n.layer)).length >= 2) {
      hits.push({ ...at, ruleId: 'sec_service_auth_none', level: 'info', why: '서비스끼리 인증이 없어 한 서버가 뚫리면 다른 서비스를 그대로 부를 수 있습니다(측면 이동)', instead: '내부망이라도 mTLS나 서비스 계정 키를 두세요' });
    }
  }
  return hits;
}
