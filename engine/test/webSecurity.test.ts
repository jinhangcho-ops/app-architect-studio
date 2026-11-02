import { describe, expect, it } from 'vitest';
import { FORMAT_VERSION, migrate, readProject } from '../data';
import { Project } from '../schema';
import { checkSecurity, webFields, webGate } from '../security';

type Web = NonNullable<Project['web']>;
type Auth = NonNullable<Project['auth']>;
const WEB_RULES = /^sec_(web_|cors_|cookie_|token_in_storage|no_csp|csp_|no_hsts|api_key_in_browser)/;

// 화면(U) → 공개 백엔드(B). mode·auth·web만 바꿔 본다
const proj = (o: { mode?: string; auth?: Auth; web?: Web; pub?: boolean; external?: boolean } = {}): Project => Project.parse({
  name: 'p',
  deploy: { mode: o.mode ?? 'web' },
  auth: o.auth,
  web: o.web,
  nodes: [
    { id: 'U', name: '화면', layer: 'ui' },
    { id: 'B', name: '백엔드', layer: 'backend', security: { exposure: o.pub === false ? 'internal' : 'public' } },
    { id: 'X', name: '외부', layer: 'external' },
  ],
  edges: [{ from: 'U', to: o.external ? 'X' : 'B' }],
});
const jwt: Auth = { method: 'jwt' }, session: Auth = { method: 'session' };
const safeWeb: Web = { cors: 'allowlist', cookie_samesite: 'strict', cookie_httponly: true, cookie_secure: true, csrf: true, csp: 'enforce', hsts: true, token_storage: 'memory' };
const web = (p: Project) => checkSecurity(p).filter((h) => WEB_RULES.test(h.ruleId));
const ids = (p: Project) => web(p).map((h) => `${h.level}:${h.ruleId}`);

describe('웹 클라이언트 보안: 문', () => {
  it('mobile·server·local_exe면 규칙 없음, web·hybrid이고 공개 백엔드가 있으면 있음', () => {
    for (const mode of ['mobile', 'server', 'local_exe']) expect(ids(proj({ mode, auth: jwt }))).toEqual([]);
    for (const mode of ['web', 'hybrid']) expect(ids(proj({ mode, auth: jwt }))).toEqual(['conditional:sec_web_unset']);
    expect(webGate(proj({ mode: 'mobile' }))).toBe(false);
    expect(webGate(proj({ mode: 'hybrid' }))).toBe(true);
  });

  it('공개 백엔드가 없어도 화면 → 외부 연결이 있으면 열림, 둘 다 없으면 닫힘', () => {
    expect(ids(proj({ pub: false, external: true }))).toEqual(['conditional:sec_web_unset']);
    expect(ids(proj({ pub: false }))).toEqual([]);
    expect(webGate(proj({ pub: false }))).toBe(false);
  });

  it('BaaS만 있으면(공개 API 없음) CORS·HSTS는 묻지도 판정하지도 않음', () => {
    const baas = (w: Web) => proj({ pub: false, external: true, auth: jwt, web: w });
    expect(web(baas({ csp: 'enforce' })).map((h) => h.why)).toEqual(['웹 클라이언트 보안 값 미정: 토큰 보관']);
    expect(ids(baas({ ...safeWeb, cors: 'any', hsts: false }))).toEqual([]);
    expect(web(proj({ pub: false, external: true, auth: jwt })).map((h) => h.why)).toEqual(['웹 클라이언트 보안 미정: CSP·토큰 보관 값이 설계에 없습니다']);
  });
});

describe('웹 클라이언트 보안: 미정', () => {
  it('모두 비면 한 줄', () => {
    const [h] = web(proj({ auth: jwt }));
    expect(h).toMatchObject({ ruleId: 'sec_web_unset', target: '프로젝트', why: '웹 클라이언트 보안 미정: 출처 허용(CORS)·CSP·HSTS·토큰 보관 값이 설계에 없습니다', instead: '설정 › 웹 클라이언트 보안에서 정하세요' });
  });

  const some: Web = { cors: 'allowlist' };
  it('세션이면 쿠키 칸을 묻고 토큰 보관은 묻지 않음', () => {
    expect(web(proj({ auth: session, web: some })).map((h) => h.why)).toEqual(['웹 클라이언트 보안 값 미정: 쿠키 SameSite·쿠키 HttpOnly·쿠키 Secure·CSRF 토큰·CSP·HSTS']);
  });
  it('jwt면 토큰 보관을 묻고 쿠키 칸은 묻지 않음, 토큰을 쿠키에 두면 쿠키 칸도 물음', () => {
    expect(web(proj({ auth: jwt, web: some })).map((h) => h.why)).toEqual(['웹 클라이언트 보안 값 미정: CSP·HSTS·토큰 보관']);
    expect(web(proj({ auth: jwt, web: { ...some, token_storage: 'cookie' } })).map((h) => h.why)).toEqual(['웹 클라이언트 보안 값 미정: 쿠키 SameSite·쿠키 HttpOnly·쿠키 Secure·CSRF 토큰·CSP·HSTS']);
  });
  it('oauth_oidc도 토큰 기반이라 토큰 보관을 묻고 쿠키 칸은 묻지 않음', () => {
    expect(web(proj({ auth: { method: 'oauth_oidc' }, web: some })).map((h) => h.why)).toEqual(['웹 클라이언트 보안 값 미정: CSP·HSTS·토큰 보관']);
  });
  it('인증 미정이면 쿠키·토큰 칸 둘 다 묻지 않고 안내를 덧붙임', () => {
    expect(web(proj({ web: some })).map((h) => h.why)).toEqual(['웹 클라이언트 보안 값 미정: CSP·HSTS (인증 방식을 정하면 쿠키·토큰 칸도 묻습니다)']);
    expect(web(proj({})).map((h) => h.why)).toEqual(['웹 클라이언트 보안 미정: 출처 허용(CORS)·CSP·HSTS 값이 설계에 없습니다 (인증 방식을 정하면 쿠키·토큰 칸도 묻습니다)']);
  });
  it('다 정하고 안전하면 없음 (세션·jwt 모두)', () => {
    expect(ids(proj({ auth: jwt, web: safeWeb }))).toEqual([]);
    expect(ids(proj({ auth: session, web: safeWeb }))).toEqual([]);
  });
});

describe('웹 클라이언트 보안: 규칙', () => {
  const check = (auth: Auth, w: Partial<Web>) => ids(proj({ auth, web: { ...safeWeb, ...w } }));

  it('sec_cors_any: 쿠키 기반 ⚠️, 토큰 기반 ℹ️(sec_cors_any_token), 인증 미정·없음은 없음', () => {
    expect(check(session, { cors: 'any' })).toEqual(['conditional:sec_cors_any']);
    expect(web(proj({ auth: session, web: { ...safeWeb, cors: 'any' } }))[0].why).toContain('Origin 반사 + Allow-Credentials');
    expect(web(proj({ auth: jwt, web: { ...safeWeb, cors: 'any' } }))).toMatchObject([{ ruleId: 'sec_cors_any_token', level: 'info', instead: '허용 목록으로 좁히세요' }]);
    expect(check({ method: 'none' }, { cors: 'any' })).toEqual([]);
    expect(ids(proj({ web: { ...safeWeb, cors: 'any' } }))).toEqual([]);
    expect(check(jwt, { cors: 'off' })).toEqual([]);
  });

  it('sec_cookie_no_csrf: lax는 다층 방어 문구, none·미정은 기존 문구(미정은 Safari·Firefox 덧붙임), strict는 없음', () => {
    const hit = (auth: Auth, w: Partial<Web>) => web(proj({ auth, web: { ...safeWeb, ...w } })).filter((h) => h.ruleId === 'sec_cookie_no_csrf');
    expect(hit(session, { csrf: false, cookie_samesite: 'lax' })).toMatchObject([{ level: 'conditional', why: expect.stringContaining('CSRF 토큰은 다층 방어') }]);
    expect(hit(session, { csrf: false, cookie_samesite: 'none' })[0].why).toMatch(/몰래 쓰기 요청을 보낼 수 있습니다$/);
    expect(hit(session, { csrf: false, cookie_samesite: undefined })[0].why).toMatch(/Safari·Firefox는 미정을 none으로 다룹니다/);
    expect(hit(session, { csrf: false, cookie_samesite: 'strict' })).toEqual([]);
    expect(check(jwt, { csrf: false, cookie_samesite: 'lax' })).toEqual([]);
    expect(check(jwt, { csrf: false, cookie_samesite: 'lax', token_storage: 'cookie' })).toEqual(['conditional:sec_cookie_no_csrf']);
  });

  it('sec_cookie_js: 쿠키 기반 + HttpOnly 끔', () => {
    expect(web(proj({ auth: session, web: { ...safeWeb, cookie_httponly: false } }))).toMatchObject([{ ruleId: 'sec_cookie_js', instead: 'HttpOnly 켬' }]);
    expect(check(jwt, { cookie_httponly: false })).toEqual([]);
  });

  it('sec_cookie_insecure: 쿠키 기반 + Secure 끔 (none이면 브라우저 거부 문구)', () => {
    expect(check(session, { cookie_secure: false })).toEqual(['conditional:sec_cookie_insecure']);
    expect(web(proj({ auth: session, web: { ...safeWeb, cookie_secure: false } }))[0]).toMatchObject({ why: '쿠키에 Secure가 없어 http 요청 한 번에 세션 쿠키가 평문으로 나갑니다', instead: 'Secure 켬' });
    const none = web(proj({ auth: session, web: { ...safeWeb, cookie_secure: false, cookie_samesite: 'none' } })).find((h) => h.ruleId === 'sec_cookie_insecure');
    expect(none?.why).toMatch(/\(SameSite=none 쿠키는 Secure 없이는 브라우저가 거부합니다\)$/);
    expect(check(jwt, { cookie_secure: false })).toEqual([]);
  });

  it('sec_api_key_in_browser: API 키 방식 (BaaS만 있어도)', () => {
    expect(web(proj({ auth: { method: 'api_key' }, web: safeWeb }))).toMatchObject([{ ruleId: 'sec_api_key_in_browser', level: 'conditional', instead: '사용자 로그인 토큰을 쓰거나, 키에 도메인·범위·속도 제한을 두세요' }]);
    expect(ids(proj({ pub: false, external: true, auth: { method: 'api_key' }, web: safeWeb }))).toEqual(['conditional:sec_api_key_in_browser']);
    expect(check(jwt, {})).toEqual([]);
  });

  it('sec_token_in_storage: localStorage', () => {
    expect(web(proj({ auth: jwt, web: { ...safeWeb, token_storage: 'local_storage' } }))).toMatchObject([{ ruleId: 'sec_token_in_storage', level: 'conditional', why: '토큰을 localStorage에 두면 XSS 스크립트가 그대로 읽어 갑니다' }]);
    expect(check(jwt, { token_storage: 'memory' })).toEqual([]);
  });

  it('sec_no_csp ⚠️, sec_csp_report_only ℹ️', () => {
    expect(check(jwt, { csp: 'none' })).toEqual(['conditional:sec_no_csp']);
    expect(check(jwt, { csp: 'report_only' })).toEqual(['info:sec_csp_report_only']);
  });

  it('sec_no_hsts', () => {
    expect(check(jwt, { hsts: false })).toEqual(['conditional:sec_no_hsts']);
  });

  it('sec_cookie_samesite_none: 쿠키 기반 + none + CSRF 있음이면 ℹ️, CSRF 없으면 no_csrf ⚠️만', () => {
    expect(check(session, { cookie_samesite: 'none' })).toEqual(['info:sec_cookie_samesite_none']);
    expect(check(session, { cookie_samesite: 'none', csrf: false })).toEqual(['conditional:sec_cookie_no_csrf']);
    expect(check(jwt, { cookie_samesite: 'none' })).toEqual([]);
  });
});

describe('웹 클라이언트 보안: webFields·파일', () => {
  it('비면 미정, 값은 한국어 이름', () => {
    expect(webFields(proj())).toEqual([
      ['출처 허용(CORS)', '미정'], ['쿠키 SameSite', '미정'], ['쿠키 HttpOnly', '미정'], ['쿠키 Secure', '미정'], ['CSRF 토큰', '미정'], ['CSP', '미정'], ['HSTS', '미정'], ['토큰 보관', '미정'],
    ]);
    expect(webFields(proj({ web: { ...safeWeb, csrf: false } })).map(([, v]) => v)).toEqual(['허용 목록', '엄격(strict)', '켬', '켬', '끔', '강제', '켬', '메모리']);
  });

  it('형식 13: 12 파일은 그대로 열리고, web 값은 왕복됨', () => {
    expect(FORMAT_VERSION).toBe(13);
    expect(migrate({ name: 'p', format_version: 12 })).toEqual({ name: 'p' });
    const p = readProject({ name: 'p', format_version: 13, nodes: [], web: safeWeb }, []);
    expect(p.web).toEqual(safeWeb);
  });

  it('모르는 web 값은 빼고 열고 notes에 적음', () => {
    const notes: string[] = [];
    const p = readProject({ name: 'p', nodes: [], web: { cors: 'world', hsts: 'yes', csp: 'enforce' } }, [], '파일', notes);
    expect(p.web).toEqual({ csp: 'enforce' });
    expect(notes).toHaveLength(2);
    expect(notes.join('\n')).toMatch(/web\.cors = "world"/);
  });
});
