import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyze } from '../analyze';
import { FORMAT_VERSION, migrate, readProject } from '../data';
import { failureLines } from '../failure';
import { loadCatalog, loadLaws, loadPrices, loadProject } from '../io';
import type { Project, ProjectNode } from '../schema';
import { checkSecurity } from '../security';

const root = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const catalog = loadCatalog(root('data/catalog'));
// 장부 앱 D-01(Supabase, db, 테이블 있음, 백업·복사본 없음)을 바꿔 가며 본다
const ledger = loadProject(root('examples/ledger-fastapi.json'), catalog.items);
type Backup = NonNullable<ProjectNode['backup']>;
const PERSONAL: ProjectNode['privacy'] = { personal: true, sensitive: false, unique_id: false, subjects: [], sends_external: false };
const withDb = (patch: Partial<ProjectNode>, p: Project = ledger): Project => ({ ...p, nodes: p.nodes.map((n) => (n.id === 'D-01' ? { ...n, ...patch } : n)) });
const hits = (p: Project, rule: string) => checkSecurity(p).filter((h) => h.ruleId === rule && h.node === 'D-01');
const unsetWhy = (p: Project) => hits(p, 'sec_unset')[0]?.why ?? '';
// 다 정해 둔 안전한 백업 (여기서 하나씩 바꿔 본다)
const safe: Backup = { every_h: 24, pitr: true, encrypted: true, immutable: true, retention_days: 14, restore_tested: true, restore_tested_on: '2026-10-01' };
const b = (patch: Partial<Backup>): Backup => ({ ...safe, ...patch });

describe('백업 보호 점검', () => {
  it('sec_no_backup: 테이블이 있는 db에 백업·복사본이 없으면 ⚠️, 백업이 있으면 없음', () => {
    expect(hits(withDb({ backup: undefined, dr: undefined }), 'sec_no_backup')).toHaveLength(1);
    expect(hits(withDb({ backup: safe }), 'sec_no_backup')).toHaveLength(0);
  });

  it('sec_no_backup: 다른 리전 대기 복제본만이면 있음 + 복제본은 백업이 아니라는 문구', () => {
    const h = hits(withDb({ dr: { region: 'aws:ap-northeast-1', mode: 'standby' } }), 'sec_no_backup');
    expect(h).toHaveLength(1);
    expect(h[0].why).toContain('복제본은 삭제·손상도 함께 복제되어 백업을 대신하지 못합니다');
  });

  it('sec_no_backup: 다른 리전 백업(mode backup)만 골랐으면 주기가 비었다는 문구', () => {
    const h = hits(withDb({ dr: { region: 'aws:ap-northeast-1', mode: 'backup' } }), 'sec_no_backup');
    expect(h).toHaveLength(1);
    expect(h[0].why).toContain('백업 주기가 비어 있습니다');
    expect(h[0].why).not.toContain('복제본');
  });

  it('sec_no_backup: analytics 노드도 해당', () => {
    expect(hits(withDb({ layer: 'analytics' }), 'sec_no_backup')).toHaveLength(1);
  });

  it('sec_no_backup: 캐시 노드, 테이블도 개인정보도 없는 db는 없음, 개인정보 db는 테이블 없어도 있음', () => {
    expect(hits(withDb({ layer: 'cache' }), 'sec_no_backup')).toHaveLength(0);
    expect(hits(withDb({ tables: [] }), 'sec_no_backup')).toHaveLength(0);
    expect(hits(withDb({ tables: [], privacy: PERSONAL }), 'sec_no_backup')).toHaveLength(1);
  });

  it('sec_backup_plain: 개인정보 노드 백업 암호화 끔이면 ⚠️, 개인정보 아니거나 켬이면 없음', () => {
    const h = hits(withDb({ privacy: PERSONAL, backup: b({ encrypted: false }) }), 'sec_backup_plain');
    expect(h).toHaveLength(1);
    expect(h[0].level).toBe('conditional');
    expect(hits(withDb({ backup: b({ encrypted: false }) }), 'sec_backup_plain')).toHaveLength(0);
    expect(hits(withDb({ privacy: PERSONAL, backup: safe }), 'sec_backup_plain')).toHaveLength(0);
  });

  it('sec_backup_mutable: 변조 방지 끔이면 ⚠️, 켬이면 없음', () => {
    expect(hits(withDb({ backup: b({ immutable: false }) }), 'sec_backup_mutable')).toHaveLength(1);
    expect(hits(withDb({ backup: safe }), 'sec_backup_mutable')).toHaveLength(0);
  });

  it('sec_backup_retention_short: max(7일, 백업 주기 2번)보다 짧으면 ⚠️', () => {
    const h = hits(withDb({ backup: b({ retention_days: 6 }) }), 'sec_backup_retention_short');
    expect(h).toHaveLength(1);
    expect(h[0].why).toContain('보관 6일이 기준 7일(7일 또는 백업 주기 2번)보다 짧아');
    expect(h[0].instead).toBe('백업 주기 2번 이상, 최소 7일, 규제 데이터는 더 길게');
    expect(hits(withDb({ backup: b({ retention_days: 7 }) }), 'sec_backup_retention_short')).toHaveLength(0);
    // 10일마다 백업: 2번 = 20일
    expect(hits(withDb({ backup: b({ every_h: 240, retention_days: 14 }) }), 'sec_backup_retention_short')).toHaveLength(1);
    expect(hits(withDb({ backup: b({ every_h: 240, retention_days: 20 }) }), 'sec_backup_retention_short')).toHaveLength(0);
    expect(hits(withDb({ backup: b({ retention_days: undefined }) }), 'sec_backup_retention_short')).toHaveLength(0);
  });

  it('sec_restore_untested: 복구 훈련 없음이면 ⚠️, 했으면 없음', () => {
    expect(hits(withDb({ backup: b({ restore_tested: false }) }), 'sec_restore_untested')).toHaveLength(1);
    expect(hits(withDb({ backup: safe }), 'sec_restore_untested')).toHaveLength(0);
  });

  it('sec_restore_stale: 1년 넘으면 ⚠️, 180일 넘으면 ℹ️, 그 안이면 없음, ctx(today) 없으면 건너뜀', () => {
    const run = (on: string | undefined, today: string | null = '2026-11-02') =>
      checkSecurity(withDb({ backup: b({ restore_tested_on: on }) }), today ? { nodeEventRps: () => undefined, concurrentEvent: 0, today } : undefined).filter((h) => h.ruleId === 'sec_restore_stale' && h.node === 'D-01');
    const old = run('2025-10-01');
    expect(old).toHaveLength(1);
    expect(old[0].level).toBe('conditional');
    expect(old[0].why).toContain('마지막 복구 훈련이 397일 전이라 지금 데이터 크기·스키마로도 되살려지는지 알 수 없습니다');
    expect(old[0].instead).toBe('분기마다 복구 훈련을 하고 날짜를 갱신하세요');
    expect(run('2026-11-02', '2027-11-03')[0].level).toBe('conditional'); // 366일
    expect(run('2026-11-02', '2027-11-02')).toHaveLength(1); // 365일: ℹ️
    expect(run('2026-11-02', '2027-11-02')[0].level).toBe('info');
    expect(run('2026-05-01')[0].level).toBe('info'); // 185일
    expect(run('2026-05-10')).toHaveLength(0); // 176일
    expect(run('2025-10-01', null)).toHaveLength(0);
  });

  it('미정: 복구 훈련을 했다면서 날짜가 없으면 복구 훈련 날짜', () => {
    expect(unsetWhy(withDb({ backup: b({ restore_tested_on: undefined }) }))).toContain('복구 훈련 날짜');
    expect(unsetWhy(withDb({ backup: b({ restore_tested: false, restore_tested_on: undefined }) }))).not.toContain('복구 훈련 날짜');
    expect(unsetWhy(withDb({ backup: b({ retention_days: undefined }) }))).toContain('백업 보관 일수');
  });

  it('미정: sec_unset의 instead는 장애 대비 안내를 포함', () => {
    const h = hits(withDb({ backup: { every_h: 24, pitr: false } }), 'sec_unset');
    expect(h[0].instead).toContain('장애 대비');
  });

  it('sec_personal_plain: 백업이 암호화돼 있으면 문구에서 백업을 뺌', () => {
    const plainOff = { privacy: PERSONAL, security: { ...ledger.nodes.find((n) => n.id === 'D-01')!.security, at_rest: false } };
    expect(hits(withDb({ ...plainOff, backup: safe }), 'sec_personal_plain')[0].why).not.toContain('백업');
    expect(hits(withDb({ ...plainOff, backup: undefined }), 'sec_personal_plain')[0].why).toContain('디스크·백업이 새면');
  });

  it('미정: 비어 있으면 sec_unset에 더함, 백업 암호화는 개인정보 노드만', () => {
    const bare: Backup = { every_h: 24, pitr: false };
    const plain = unsetWhy(withDb({ backup: bare }));
    expect(plain).toContain('백업 변조 방지');
    expect(plain).toContain('복구 훈련');
    expect(plain).not.toContain('백업 암호화');
    expect(unsetWhy(withDb({ backup: bare, privacy: PERSONAL }))).toContain('백업 암호화');
    const done = unsetWhy(withDb({ backup: safe, privacy: PERSONAL }));
    expect(done).not.toContain('백업');
    expect(done).not.toContain('복구 훈련');
    // 백업이 없으면 미정이 아니라 sec_no_backup
    expect(unsetWhy(withDb({ backup: undefined }))).not.toContain('복구 훈련');
  });
});

describe('장애 줄의 백업 상태', () => {
  const d = { catalog: catalog.byId, rules: catalog.rules, prices: loadPrices(root('data/prices')), laws: loadLaws(root('data/laws')) };
  // global-commerce N-06: 시점 복구 백업 + 서울 대기 복사본
  const gc = loadProject(root('examples/global-commerce.json'), catalog.items);
  const line = (backup: Backup | undefined, personal = true) => {
    const p: Project = { ...gc, nodes: gc.nodes.map((n) => (n.id === 'N-06' ? { ...n, backup, privacy: personal ? PERSONAL : undefined } : n)) };
    const a = analyze(p, d, '2026-10-25');
    return failureLines(a.failure!, (x) => p.nodes.find((n) => n.id === x)?.name ?? x, 'N-06').find((l) => l.includes('데이터:'))!;
  };

  it('보관 일수·암호화·변조 방지·복구 훈련 날짜', () => {
    expect(line(b({ immutable: false }))).toMatch(/ · 백업 보관 14일 · 암호화 켬 · 변조 방지 끔 · 복구 훈련 2026-10-01$/);
  });

  it('비면 미정, 보관 일수가 없으면 보관 미정, 훈련 했음·없음', () => {
    expect(line({ every_h: 24, pitr: true })).toMatch(/ · 백업 보관 미정 · 암호화 미정 · 변조 방지 미정 · 복구 훈련 미정$/);
    // 개인정보가 아닌 노드는 암호화 미정을 생략하되, 값이 있으면 켬·끔은 그대로
    expect(line({ every_h: 24, pitr: true }, false)).toMatch(/ · 백업 보관 미정 · 변조 방지 미정 · 복구 훈련 미정$/);
    expect(line({ every_h: 24, pitr: true }, false)).not.toContain('암호화');
    expect(line(b({}), false)).toContain(' · 암호화 켬');
    expect(line({ every_h: 24, pitr: true, restore_tested: true })).toMatch(/ · 복구 훈련 했음$/);
    expect(line({ every_h: 24, pitr: true, restore_tested: false })).toMatch(/ · 복구 훈련 없음$/);
  });

  it('백업이 없으면 붙이지 않음', () => {
    expect(line(undefined)).not.toContain('암호화');
  });
});

describe('형식 버전 12', () => {
  it('버전 11 파일은 그대로 열림', () => {
    expect(FORMAT_VERSION).toBeGreaterThanOrEqual(12);
    expect(migrate({ name: 'p', format_version: 11 })).toEqual({ name: 'p' });
  });

  const raw = (backup: object) => ({ name: 'p', nodes: [{ id: 'd', name: 'D', layer: 'db', primary: 'x', backup }] });

  it('백업 칸 왕복: 읽고 다시 읽어도 그대로', () => {
    const p = readProject(raw(safe), [], '파일', []);
    expect(p.nodes[0].backup).toEqual(safe);
    expect(readProject(JSON.parse(JSON.stringify(p)), [], '파일', []).nodes[0].backup).toEqual(safe);
  });

  it('모르는 값·틀린 날짜·0일 보관은 그 칸을 빼고 엶 (미정)', () => {
    const notes: string[] = [];
    const p = readProject(raw({ every_h: 24, encrypted: 'yes', immutable: 1, restore_tested: 'y', restore_tested_on: '2026/10/01', retention_days: 0 }), [], '파일', notes);
    expect(p.nodes[0].backup).toEqual({ every_h: 24, pitr: false });
    expect(notes).toHaveLength(5);
  });

  it('없는 날짜(2026-13-45)는 거부하고 그 칸만 뺌', () => {
    const p = readProject(raw({ every_h: 24, restore_tested: true, restore_tested_on: '2026-13-45' }), [], '파일', []);
    expect(p.nodes[0].backup).toEqual({ every_h: 24, pitr: false, restore_tested: true });
  });
});
