// 네트워크·보안 점검 (v1.3.0): 노드·연결선의 보안 값과 구조로 ❌(막아야 함)·⚠️(확인 필요)·ℹ️(알아 둘 것)을 낸다.
// 비어 있는 값은 "미정"으로 노드·연결선마다 한 줄로 묶어 ⚠️ (사용자 결정: 비면 모두 확인 필요). 기존 항목 판정(judgements)과 따로 낸다.
import type { Layer } from './model';
import { itemIds, nodeRegion, type Project, type ProjectEdge, type ProjectNode } from './schema';

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

// rate_limit_rpm·audit_retention_months는 rate_limit·audit_log 칸에 딸린 값이라 따로 칸으로 세지 않음
type Field = Exclude<keyof NonNullable<ProjectNode['security']>, 'rate_limit_rpm' | 'audit_retention_months'>;
/** 트래픽과 대조할 때 쓰는 값 (analyze가 채움): 노드 이벤트 피크 RPS, 이벤트 피크 동시 접속자,
 *  노드부터 그 뒤 동기 호출까지의 p99(ms)·노드 사용률(타임아웃·재시도 점검. perf·대수 계산이 있는 노드만) */
export type SecurityCtx = {
  nodeEventRps: (id: string) => number | undefined; concurrentEvent: number;
  downstreamP99Ms?: (id: string, s: 'normal' | 'event') => number | undefined;
  nodeUtil?: (id: string, s: 'normal' | 'event') => number | undefined;
  /** 오늘 'YYYY-MM-DD' (복구 훈련이 오래됐는지 볼 때) */
  today?: string;
};
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
export const WEB_CORS_NAMES = { off: '끔(같은 출처만)', allowlist: '허용 목록', any: '모든 출처(Origin 반사)' } as const;
export const COOKIE_SAMESITE_NAMES = { strict: '엄격(strict)', lax: '느슨(lax)', none: '없음(none)' } as const;
export const CSP_NAMES = { enforce: '강제', report_only: '보고만', none: '없음' } as const;
export const TOKEN_STORAGE_NAMES = { cookie: '쿠키', memory: '메모리', local_storage: 'localStorage' } as const;
export const PROTECTION_NAMES = { none: '없음', encrypt: '컬럼 암호화', tokenize: '토큰화', mask: '마스킹(표시 때)' } as const;
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
  if (f === 'audit_log' && v === true && n.security?.audit_retention_months !== undefined) return `켬 (${n.security.audit_retention_months}개월)`;
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

type WebKey = keyof NonNullable<Project['web']>;
const WEB_LABELS: [WebKey, string][] = [
  ['cors', '출처 허용(CORS)'], ['cookie_samesite', '쿠키 SameSite'], ['cookie_httponly', '쿠키 HttpOnly'], ['cookie_secure', '쿠키 Secure'], ['csrf', 'CSRF 토큰'], ['csp', 'CSP'], ['hsts', 'HSTS'], ['token_storage', '토큰 보관'],
];
/** 프로젝트 웹 클라이언트 보안 값을 [칸 이름, 글자]로 (설계서 표·명령줄 한 줄). 비면 미정 */
export function webFields(p: Project): [string, string][] {
  const w = p.web ?? {};
  const names: Partial<Record<WebKey, Record<string, string>>> = { cors: WEB_CORS_NAMES, cookie_samesite: COOKIE_SAMESITE_NAMES, csp: CSP_NAMES, token_storage: TOKEN_STORAGE_NAMES };
  return WEB_LABELS.map(([k, label]) => {
    const v = w[k];
    return [label, typeof v === 'boolean' || v === undefined ? state(v) : names[k]![v]];
  });
}

const layerOf = (p: Project, id: string) => p.nodes.find((n) => n.id === id)?.layer;
const publicApis = (p: Project) => p.nodes.filter((n) => n.security?.exposure === 'public' && (n.layer === 'gateway' || n.layer === 'backend'));
/** 인증·인가를 따지는 문: 인터넷 공개 gateway·backend가 있거나, 화면이 외부 서비스를 바로 부를 때(BaaS) */
export const authGate = (p: Project) => publicApis(p).length > 0 || p.edges.some((e) => layerOf(p, e.from) === 'ui' && layerOf(p, e.to) === 'external');
/** 웹 클라이언트 보안을 따지는 문: 인증 문이 열리고 브라우저에서 도는 앱(deploy.mode web·hybrid) */
export const webGate = (p: Project) => authGate(p) && (p.deploy.mode === 'web' || p.deploy.mode === 'hybrid');

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
      hits.push({ ...at, ruleId: 'sec_personal_plain', level: 'fail', why: `${n.name}에 개인정보가 있는데 저장 암호화가 꺼져 있어 ${n.backup?.encrypted === true ? '디스크가' : '디스크·백업이'} 새면 그대로 읽힙니다`, instead: 'DB·디스크 암호화를 켜고(대부분의 관리형 DB는 기본값), 민감 컬럼은 따로 암호화하세요' });
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
    // 10. 감사 로그(접속기록) 보관이 개인정보 안전성 확보조치 기준(1년)보다 짧음
    const months = s.audit_retention_months, auditing = s.audit_log === true && relevant(p, n).includes('audit_log');
    // 개인정보 노드는 자기 privacy, 공개 API는 프로젝트의 개인정보 노드들로 기준을 정함. 한국 고시라 주체가 정해졌는데 KR이 없으면 건너뜀
    const owners = n.privacy?.personal ? [n] : p.nodes.filter((x) => x.privacy?.personal);
    const need = owners.some((x) => x.privacy?.unique_id || x.privacy?.sensitive) || (p.scale?.users ?? 0) >= 50000 ? 24 : 12;
    const noKr = owners.every((x) => x.privacy?.subjects?.length && !x.privacy.subjects.includes('KR'));
    if (auditing && months !== undefined && months < need && !noKr) {
      hits.push({ ...at, ruleId: 'sec_audit_short', level: 'conditional', why: `접속기록 보관 ${months}개월이 개인정보 안전성 확보조치 기준(${need}개월: 1년, 5만 명 이상·고유식별정보·민감정보는 2년)보다 짧습니다`, instead: `${need}개월 이상 보관하고 월 1회 점검하세요` });
    }
    // 11·12. 개인정보 컬럼이 있는 테이블: 컬럼 보호 없음·미정, 보관 일수를 테이블에 직접 정하지 않음 (scale 값은 크기 가정이지 파기 결정이 아님)
    for (const t of n.tables) {
      const personal = t.columns.filter((c) => c.personal);
      if (!personal.length) continue;
      const tat = { node: n.id, target: `${n.name}.${t.name}` };
      // 고유식별·민감 노드에서 마스킹은 표시만 가려 저장된 값은 그대로라 보호로 치지 않음
      const strict = n.privacy?.unique_id || n.privacy?.sensitive;
      const plain = personal.filter((c) => c.protection === undefined || c.protection === 'none' || (c.protection === 'mask' && strict));
      const undecided = plain.filter((c) => c.protection === undefined).length;
      const masked = plain.some((c) => c.protection === 'mask');
      if (plain.length) hits.push({ ...tat, ruleId: 'sec_column_plain', level: 'conditional', why: `개인정보 컬럼 ${plain.map((c) => c.name).join('·')}에 보호가 없습니다(저장 암호화와 별개로 조회 결과·백업·로그에 그대로 보임)${undecided ? ` (미정 ${undecided}개)` : ''}${masked ? ' (마스킹은 표시용이라 저장 암호화가 필요)' : ''}`, instead: '식별자는 토큰화, 연락처·주민번호 류는 컬럼 암호화, 화면 표시는 마스킹' });
      if (t.retention_days === undefined) hits.push({ ...tat, ruleId: 'sec_no_retention', level: 'conditional', why: '개인정보 테이블에 보관 기간이 없어 파기 시점을 정할 수 없습니다', instead: '목적 달성 뒤 지체 없이 파기(개인정보 보호법 제21조) — 보관 일수를 정하고 배치로 지우거나 분리 보관' });
    }
    // 13~17. 데이터 노드 백업: 없음(다른 리전 복사본도 없음)·암호화 끔(개인정보)·변조 방지 끔·보관 짧음·복구 훈련 없음
    const bk = n.backup;
    if ((n.layer === 'db' || n.layer === 'analytics') && (n.tables.length || n.privacy?.personal) && !bk) {
      const note = n.dr?.mode === 'backup' ? ' (다른 리전 백업을 골랐지만 백업 주기가 비어 있습니다)' : n.dr ? ' (다른 리전 복제본은 삭제·손상도 함께 복제되어 백업을 대신하지 못합니다)' : '';
      hits.push({ ...at, ruleId: 'sec_no_backup', level: 'conditional', why: `데이터가 망가지거나 지워지면 되살릴 길이 없습니다${note}`, instead: '백업 주기를 정하고(관리형 DB는 자동 백업 켬), 시점 복구를 켜세요' });
    }
    if (bk && n.privacy?.personal && bk.encrypted === false) {
      hits.push({ ...at, ruleId: 'sec_backup_plain', level: 'conditional', why: '백업이 암호화되지 않아 백업 파일이 새면 개인정보가 그대로 읽힙니다', instead: '백업 암호화를 켜고 키는 KMS에' });
    }
    if (bk && bk.immutable === false) {
      hits.push({ ...at, ruleId: 'sec_backup_mutable', level: 'conditional', why: '백업을 지우거나 덧쓸 수 있어 랜섬웨어·실수 삭제 때 원본과 함께 사라집니다', instead: '변조 불가(WORM)·삭제 잠금을 켜고 다른 계정·리전에 복사본을 두세요' });
    }
    // 백업 주기 두 번은 남아야 손상을 알아챈 뒤 깨끗한 것을 고를 수 있음
    const minDays = bk ? Math.max(7, (2 * bk.every_h) / 24) : 0;
    if (bk && bk.retention_days !== undefined && bk.retention_days < minDays) {
      hits.push({ ...at, ruleId: 'sec_backup_retention_short', level: 'conditional', why: `보관 ${bk.retention_days}일이 기준 ${Math.ceil(minDays)}일(7일 또는 백업 주기 2번)보다 짧아 손상을 늦게 알아채면 깨끗한 백업이 이미 지워진 뒤입니다`, instead: '백업 주기 2번 이상, 최소 7일, 규제 데이터는 더 길게' });
    }
    if (bk && bk.restore_tested === false) {
      hits.push({ ...at, ruleId: 'sec_restore_untested', level: 'conditional', why: '되살려 본 적이 없어 백업이 정상인지, 복구 시간이 맞는지 알 수 없습니다', instead: '분기마다 복구 훈련을 하고 날짜와 되살리는 속도를 적으세요' });
    }
    // 훈련 날짜가 오래되면 지금 데이터 크기·스키마로 되살려지는지 모름 (1년 넘음 ⚠️, 반년 넘음 ℹ️)
    if (bk?.restore_tested === true && bk.restore_tested_on && ctx?.today) {
      const d = Math.floor((Date.parse(ctx.today) - Date.parse(bk.restore_tested_on)) / 86_400_000);
      if (d > 180) hits.push({ ...at, ruleId: 'sec_restore_stale', level: d > 365 ? 'conditional' : 'info', why: `마지막 복구 훈련이 ${d}일 전이라 지금 데이터 크기·스키마로도 되살려지는지 알 수 없습니다`, instead: '분기마다 복구 훈련을 하고 날짜를 갱신하세요' });
    }
    // 미정: 이 노드에서 정해야 하는 칸 중 비어 있는 것 (감사 로그가 켬이면 보관 기간도, 백업이 있으면 백업 보호 칸도)
    const unset = relevant(p, n).filter((f) => s[f] === undefined && !(f === 'rate_limit' && rateLimited(n))).map((f) => SECURITY_FIELD_NAMES[f]);
    if (auditing && months === undefined) unset.push('감사 로그 보관 기간');
    if (bk && n.privacy?.personal && bk.encrypted === undefined) unset.push('백업 암호화');
    if (bk && bk.immutable === undefined) unset.push('백업 변조 방지');
    if (bk && bk.retention_days === undefined) unset.push('백업 보관 일수');
    if (bk && bk.restore_tested === undefined) unset.push('복구 훈련');
    if (bk?.restore_tested === true && bk.restore_tested_on === undefined) unset.push('복구 훈련 날짜');
    // 법령·감사 로그 판정은 노드 개인정보 속성 기준이라, 컬럼만 표시하고 노드를 비워 두면 알림
    if (!n.privacy?.personal && n.tables.some((t) => t.columns.some((c) => c.personal))) unset.push('개인정보 속성(개인정보 컬럼 있음)');
    if (unset.length) hits.push({ ...at, ruleId: 'sec_unset', level: 'conditional', why: `보안 값 미정: ${unset.join('·')}`, instead: unset.some((u) => u.startsWith('백업') || u.startsWith('복구 훈련')) ? '노드 패널 › 네트워크·보안에서, 백업 칸은 장애 대비에서 정하세요' : '노드 패널 › 네트워크·보안에서 정하세요' });
  }

  for (const e of p.edges) {
    const target = `${nameOf(e.from)} → ${nameOf(e.to)}`, at = { edge: [e.from, e.to] as [string, string], target };
    const net = edgeNet(p, e), tls = e.security?.tls;
    // 2. 인터넷을 지나는데 암호화 없음
    if (net === 'internet' && tls === 'none') {
      hits.push({ ...at, ruleId: 'sec_plain_internet', level: 'fail', why: `${target} 연결이 인터넷을 지나는데 암호화하지 않아 중간에서 토큰·데이터를 엿보거나 바꿀 수 있습니다`, instead: 'HTTPS(TLS)로 바꾸세요. 서비스끼리는 mTLS로 서로를 확인할 수 있습니다' });
    }
    // 암호화·망·타임아웃 중 하나라도 비면 한 줄 (타임아웃 미정은 별도 줄 없이 여기에 붙인다)
    const edgeUnset = [tls === undefined && '암호화', tls === undefined && !net && '지나는 망', e.sync && e.timeout_ms === undefined && '타임아웃'].filter(Boolean);
    if (edgeUnset.length) hits.push({ ...at, ruleId: 'sec_edge_unset', level: 'conditional', why: `보안 값 미정: ${edgeUnset.join('·')}`, instead: '연결선 패널 › 네트워크·보안에서 정하세요' });
    // 타임아웃·재시도 (동기 연결선만). retries가 비면 재시도 없음
    if (e.sync) {
      const t = e.timeout_ms, r = e.retries ?? 0;
      const p99 = ctx?.downstreamP99Ms?.(e.to, 'event'), u = ctx?.nodeUtil?.(e.to, 'event');
      if (t !== undefined && p99 !== undefined && t < p99) {
        hits.push({ ...at, ruleId: 'net_timeout_short', level: 'conditional', why: `타임아웃 ${t}ms가 받는 쪽과 그 뒤 동기 호출의 p99 ${Math.ceil(p99)}ms보다 짧아 정상 요청도 끊깁니다`, instead: 'p99의 1.5~2배로 두고, 더 줄이려면 받는 노드를 빠르게 하세요' });
      } else if (t !== undefined && p99 !== undefined && t < 1.5 * p99) {
        hits.push({ ...at, ruleId: 'net_timeout_tight', level: 'info', why: `타임아웃 ${t}ms가 p99 ${Math.ceil(p99)}ms에 가까워 느린 1%가 끊깁니다`, instead: 'p99의 1.5~2배로' });
      }
      if (r >= 1 && t === undefined) {
        hits.push({ ...at, ruleId: 'net_retry_no_timeout', level: 'conditional', why: '타임아웃 없이 재시도하면 느린 요청이 끝날 때까지 기다렸다 또 보내 스레드·연결이 쌓입니다', instead: '타임아웃을 먼저 정하세요' });
      }
      // shortcut: 최악(모든 요청이 실패해 retries번 다시 보냄)만 보고, 받는 노드 부하가 모두 이 연결선에서 온다고 봄. 실패율·연결선별 부하를 받게 되면 1 + 실패율 × retries를 이 선의 몫에만 곱하기로
      if (r >= 1 && u !== undefined && u * (1 + r) > 1) {
        const why = `받는 노드가 느려져 모두 재시도하면 부하가 ${1 + r}배가 되어 사용률 ${Math.round(u * (1 + r) * 100)}% — 재시도가 장애를 키웁니다`;
        const instead = r >= 2 ? '재시도는 1회로 줄이고 지수 백오프·지터로, 서킷 브레이커로 끊으세요' : '지수 백오프·지터를 두고 서킷 브레이커로 끊으세요';
        hits.push(e.breaker === true
          ? { ...at, ruleId: 'net_retry_storm', level: 'info', why: `${why} (브레이커가 끊어 주지만 끊기 전까지는 같음)`, instead }
          : { ...at, ruleId: 'net_retry_storm', level: 'conditional', why, instead });
      }
      if (r >= 1 && e.breaker === false) {
        hits.push({ ...at, ruleId: 'net_no_breaker', level: 'info', why: '재시도만 있고 서킷 브레이커가 없어 받는 쪽이 죽어 있어도 계속 두드립니다', instead: '연속 실패 N회면 잠시 끊는 브레이커를 두세요' });
      }
      // 받는 노드에서 나가는 동기 연결선 중 재시도까지 포함한 최대 대기(타임아웃 × (1 + 재시도))가 가장 긴 것
      const most = (x: ProjectEdge) => x.timeout_ms! * (1 + (x.retries ?? 0));
      const inner = p.edges.filter((x) => x.from === e.to && x.sync && x.timeout_ms !== undefined).sort((a, b) => most(b) - most(a))[0];
      if (t !== undefined && inner && most(inner) >= t) {
        hits.push({ ...at, ruleId: 'net_timeout_chain', level: 'conditional', why: `${target} 타임아웃 ${t}ms보다 안쪽 ${nameOf(inner.from)} → ${nameOf(inner.to)} 타임아웃 ${inner.timeout_ms}ms(재시도 포함 최대 ${most(inner)}ms)가 같거나 길어, 바깥이 먼저 포기한 뒤에도 안쪽은 계속 돕니다`, instead: '안쪽 타임아웃을 바깥보다 짧게(바깥 ≥ Σ 안쪽 + 처리 시간)' });
      }
    }
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
  const pub = publicApis(p);
  if (authGate(p)) {
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
    // 웹 클라이언트 보안 (브라우저에서 도는 앱만): CORS·쿠키·CSRF·CSP·HSTS·토큰 보관
    if (webGate(p)) {
      const w = p.web ?? {};
      // 인증 방식이 미정이면 쿠키·토큰 기반 둘 다 아님
      const cookie = a.method === 'session' || w.token_storage === 'cookie';
      const token = a.method === 'jwt' || a.method === 'oauth_oidc';
      // 공개 gateway·backend가 없으면(BaaS만) CORS·HSTS는 사업자가 정하므로 묻지도 판정하지도 않음
      const api = publicApis(p).length > 0;
      const ask = (k: WebKey) => (k === 'cors' || k === 'hsts' ? api : k === 'token_storage' ? token : k === 'csp' ? true : cookie);
      const hint = a.method === undefined ? ' (인증 방식을 정하면 쿠키·토큰 칸도 묻습니다)' : '';
      if (WEB_LABELS.every(([k]) => w[k] === undefined)) {
        hits.push({ ...at, ruleId: 'sec_web_unset', level: 'conditional', why: `웹 클라이언트 보안 미정: ${WEB_LABELS.filter(([k]) => ask(k)).map(([, l]) => l).join('·')} 값이 설계에 없습니다${hint}`, instead: '설정 › 웹 클라이언트 보안에서 정하세요' });
      } else {
        const unset = WEB_LABELS.filter(([k]) => w[k] === undefined && ask(k)).map(([, l]) => l);
        if (unset.length) hits.push({ ...at, ruleId: 'sec_web_partial', level: 'conditional', why: `웹 클라이언트 보안 값 미정: ${unset.join('·')}${hint}`, instead: '설정 › 웹 클라이언트 보안에서 정하세요' });
      }
      if (api && w.cors === 'any' && cookie) {
        hits.push({ ...at, ruleId: 'sec_cors_any', level: 'conditional', why: '모든 출처를 자격 증명과 함께 허용(Origin 반사 + Allow-Credentials)하면 다른 사이트의 스크립트가 로그인한 사용자 권한으로 API를 부릅니다', instead: '앱 도메인만 허용 목록에 넣으세요' });
      } else if (api && w.cors === 'any' && token) {
        hits.push({ ...at, ruleId: 'sec_cors_any_token', level: 'info', why: '모든 출처 허용은 토큰이 메모리에 있으면 당장 위험하지 않지만, 허용 목록이 없어 다른 사이트의 호출을 걸러 내지 못합니다', instead: '허용 목록으로 좁히세요' });
      }
      if (a.method === 'api_key') {
        hits.push({ ...at, ruleId: 'sec_api_key_in_browser', level: 'conditional', why: '브라우저 앱에 넣은 API 키는 번들·개발자 도구에서 누구나 볼 수 있어 사실상 공개됩니다', instead: '사용자 로그인 토큰을 쓰거나, 키에 도메인·범위·속도 제한을 두세요' });
      }
      if (cookie && w.csrf === false && w.cookie_samesite !== 'strict') {
        const lax = w.cookie_samesite === 'lax';
        hits.push({
          ...at, ruleId: 'sec_cookie_no_csrf', level: 'conditional',
          why: lax
            ? 'SameSite=lax는 다른 사이트의 POST는 막지만 상태를 바꾸는 GET과 같은 사이트의 다른 서브도메인에서 오는 요청은 못 막습니다 (CSRF 토큰은 다층 방어)'
            : `세션 쿠키를 쓰는데 CSRF 토큰이 없고 SameSite가 strict가 아니라, 다른 사이트가 사용자 몰래 쓰기 요청을 보낼 수 있습니다${w.cookie_samesite === undefined ? ' (Safari·Firefox는 미정을 none으로 다룹니다)' : ''}`,
          instead: 'CSRF 토큰(더블 서브밋 또는 동기화 토큰)을 두거나 SameSite=strict',
        });
      }
      if (cookie && w.cookie_httponly === false) {
        hits.push({ ...at, ruleId: 'sec_cookie_js', level: 'conditional', why: '세션 쿠키를 스크립트가 읽을 수 있어 XSS 한 번에 세션이 통째로 새나갑니다', instead: 'HttpOnly 켬' });
      }
      if (cookie && w.cookie_secure === false) {
        hits.push({ ...at, ruleId: 'sec_cookie_insecure', level: 'conditional', why: `쿠키에 Secure가 없어 http 요청 한 번에 세션 쿠키가 평문으로 나갑니다${w.cookie_samesite === 'none' ? ' (SameSite=none 쿠키는 Secure 없이는 브라우저가 거부합니다)' : ''}`, instead: 'Secure 켬' });
      }
      if (w.token_storage === 'local_storage') {
        hits.push({ ...at, ruleId: 'sec_token_in_storage', level: 'conditional', why: '토큰을 localStorage에 두면 XSS 스크립트가 그대로 읽어 갑니다', instead: '메모리에 두고 갱신 토큰만 HttpOnly 쿠키로' });
      }
      if (w.csp === 'none') {
        hits.push({ ...at, ruleId: 'sec_no_csp', level: 'conditional', why: 'CSP가 없어 XSS가 들어오면 막을 둘째 벽이 없습니다', instead: 'script-src를 앱 출처·nonce로 좁힌 CSP를 강제 모드로' });
      } else if (w.csp === 'report_only') {
        hits.push({ ...at, ruleId: 'sec_csp_report_only', level: 'info', why: 'CSP가 보고 모드라 위반을 기록만 하고 막지 않습니다', instead: '위반 보고가 잦아들면 강제 모드로' });
      }
      if (api && w.hsts === false) {
        hits.push({ ...at, ruleId: 'sec_no_hsts', level: 'conditional', why: 'HSTS가 없어 첫 접속이나 공용 와이파이에서 http로 끌어내려 가로챌 수 있습니다', instead: 'Strict-Transport-Security max-age 1년 이상, preload' });
      }
      if (cookie && w.cookie_samesite === 'none' && w.csrf === true) {
        hits.push({ ...at, ruleId: 'sec_cookie_samesite_none', level: 'info', why: 'SameSite=none은 다른 사이트에서도 쿠키가 붙습니다 (CSRF 토큰이 있어 막히지만 꼭 필요한지 확인)', instead: '임베드가 필요 없으면 lax 이상' });
      }
    }
  }
  return hits;
}
