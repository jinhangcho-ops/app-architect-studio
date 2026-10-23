// 사람이 고치는 JSON 파일(카탈로그·규칙·프로젝트)의 검증. 조건식은 읽을 때 미리 해석해 오류를 일찍 잡는다.
import { z } from 'zod';
import { parse } from './expr';
import { LAYERS } from './model';
import { STANDARD_OFFSET } from './timezones';

const parses = (s: string) => {
  try {
    parse(s);
    return true;
  } catch {
    return false;
  }
};

const Expr = z.string().refine(parses, '조건식을 해석할 수 없음');
const Layer = z.enum(LAYERS);
const Grade = z.enum(['좋음', '보통', '나쁨']);
const Resource = z.enum(['vcpu', 'memGb', 'diskIops', 'netGbps']);

export const Spec = z.object({
  vcpu: z.number().positive(),
  memGb: z.number().positive(),
  diskIops: z.number().positive(),
  netGbps: z.number().positive(),
}).partial();

const Cond = z.object({ if: Expr, why: z.string().min(1) });

export const Threshold = z.object({
  // null = 아직 확인하지 못한 값. 이 값을 쓰는 조건은 '판단 불가'가 된다
  value: z.number().nullable(),
  unit: z.string(),
  base_spec: Spec.optional(),
  bound_by: Resource.optional(),
  max: z.number().optional(),
  source: z.string().min(1),
}).refine((t) => !t.bound_by || t.base_spec?.[t.bound_by] !== undefined, '사양 보정에는 base_spec의 해당 자원 값이 필요함');

export const CatalogItem = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/),
  name: z.string(),
  area: z.enum(['서비스', '스키마·메타', '어플리케이션', '파이프라인']),
  role: z.enum(['주', '보조']),
  kind: z.enum(['알고리즘', '도구', '패턴']),
  attaches_to: z.array(Layer).min(1),
  provides: z.array(z.string()).optional(),
  goals: z.record(z.string(), Grade),
  works_when: z.array(Cond).default([]),
  fails_when: z.array(Cond).default([]),
  alternatives: z.array(z.object({ id: z.string(), better_for: z.array(z.string()), note: z.string().optional() })).default([]),
  settings: z.array(z.object({ name: z.string(), goal: z.string() })).default([]),
  thresholds: z.record(z.string(), Threshold).default({}),
  sources: z.array(z.string()).min(1),
});

export const Rule = z.object({
  id: z.string(),
  scope: z.enum(['edge', 'project']),
  if: Expr,
  why: z.string().min(1),
  instead: z.string().min(1),
});

const Vars = z.record(z.string(), z.union([z.number(), z.boolean(), z.string()]));

export const PATTERN_IDS = ['power', 'enthusiast', 'active', 'regular', 'occasional', 'rare', 'dormant'] as const;

// 16절 구동 방식
export const Deploy = z.object({
  mode: z.enum(['local_exe', 'web', 'mobile', 'hybrid', 'server']),
  offline_required: z.boolean().default(false),
  scope: z.enum(['single', 'team', 'public']).default('public'),
  targets: z.array(z.string()).default([]),
  device_spec: Spec.optional(),
});

// 4절 페르소나: 사용 패턴(프리셋) + 비율. 패턴 값은 필드별로 덮어쓸 수 있다. 크기 단위 KB = 1,000바이트
export const Persona = z.object({
  name: z.string(),
  share: z.number().min(0).max(1),
  pattern: z.enum(PATTERN_IDS),
  sessions_per_day: z.number().nonnegative().optional(),
  reads_per_session: z.number().nonnegative().optional(),
  writes_per_session: z.number().nonnegative().optional(),
  session_minutes: z.number().nonnegative().optional(),
  write_kb: z.number().nonnegative().optional(),
  response_kb: z.number().nonnegative().optional(),
  /** 하이브리드에서 접속 1회당 동기화 요청 수 (요청 1건 = 쓰기 1건) */
  sync_per_session: z.number().nonnegative().optional(),
  /** 사용자가 사는 나라. 접속 시각은 이 나라 표준시로 뽑는다 */
  country: z.string().regex(/^[A-Z]{2}$/).default('KR'),
  /** 표에 없는 나라이거나 다른 시간대 지역이면 UTC 기준 시간을 직접 넣는다 (예: 미국 서부 -8) */
  utc_offset: z.number().min(-12).max(14).optional(),
  /** 주로 깨어 있는 시간대 [시작, 끝]시 (현지 표준시). 끝이 더 작으면 자정을 넘는다 */
  window: z.tuple([z.number().min(0).max(24), z.number().min(0).max(24)]).default([8, 23]),
  /** 접속 중 창 안에 들어오는 비율. 나머지는 창 밖(밤) 시간에 고르게 퍼진다. 없으면 scale.window_share */
  window_share: z.number().min(0).max(1).optional(),
  /** 창 안 접속의 모양: 창 반폭 = window_sigma × σ인 정규분포(창 밖은 잘라냄). 클수록 가운데가 덜 붐빈다 */
  window_sigma: z.number().positive().default(2.7),
}).refine((p) => p.utc_offset !== undefined || p.country in STANDARD_OFFSET, {
  message: '표준시를 모르는 국가: utc_offset을 직접 넣어 주세요',
  path: ['country'],
});

export const Scale = z.object({
  /** 전체 활성 사용자 수(예: 월간 활성 사용자). 그날 실제로 들어오는 수(DAU)는 패턴에 따라 계산된다 */
  users: z.number().positive(),
  /** 무작위 접속 시간·횟수의 시드. 같으면 결과도 같다 */
  seed: z.number().int().default(1),
  /** 시간대별 결과를 보여줄 기준 나라(서버 운영 기준). 표준시로 바꿔 합친다 */
  report_country: z.string().regex(/^[A-Z]{2}$/).default('KR'),
  report_utc_offset: z.number().min(-12).max(14).optional(),
  /** 페르소나에 window_share가 없을 때 쓰는 서비스 전체 기본값 (창 안 접속 비율) */
  window_share: z.number().min(0).max(1).default(0.8),
  retention_days: z.number().positive().default(365),
  event_multiplier: z.number().min(1).default(1),
  overhead_k: z.number().min(1).default(2),
  burst: z.object({ share: z.number().min(0).max(1), window_s: z.number().positive(), requests: z.number().nonnegative() }).optional(),
});

export const Project = z.object({
  name: z.string(),
  deploy: Deploy.default({ mode: 'web', offline_required: false, scope: 'public', targets: [] }),
  scale: Scale.optional(),
  personas: z.array(Persona).default([])
    .refine((ps) => !ps.length || Math.abs(ps.reduce((s, p) => s + p.share, 0) - 1) < 1e-6, '페르소나 비율의 합은 1이어야 함'),
  nodes: z.array(z.object({
    id: z.string(),
    name: z.string(),
    layer: Layer,
    primary: z.string().optional(),
    extras: z.array(z.string()).default([]),
    spec: Spec.optional(),
    /** 화면 노드가 여럿일 때 이 노드로 들어오는 트래픽 비율. 없으면 화면 노드끼리 균등 */
    entry_share: z.number().min(0).max(1).optional(),
    /** 기준값 이름 → 실측값. 있으면 업계 기준값·사양 보정보다 우선한다 */
    measured: z.record(z.string(), z.number()).default({}),
    // shortcut: 1단계에서는 판정 변수를 사람이 직접 넣는다. 3단계 analyze가 계산값으로 대체한다
    vars: z.object({ normal: Vars, event: Vars }).default({ normal: {}, event: {} }),
  })),
  edges: z.array(z.object({
    from: z.string(),
    to: z.string(),
    sync: z.boolean().default(true),
    callRatio: z.number().nonnegative().default(1),
    /** 이 연결로 흐르는 요청 종류. read면 쓰기는 넘어가지 않는다 */
    carries: z.enum(['all', 'read', 'write']).default('all'),
  })).default([]),
});

export type Spec = z.infer<typeof Spec>;
export type Threshold = z.infer<typeof Threshold>;
export type CatalogItem = z.infer<typeof CatalogItem>;
export type Rule = z.infer<typeof Rule>;
export type Project = z.infer<typeof Project>;
export type ProjectNode = Project['nodes'][number];
export type Deploy = z.infer<typeof Deploy>;
export type Persona = z.infer<typeof Persona>;

/** 카탈로그 전체를 검증하고, 대안·프로젝트가 가리키는 id가 실제로 있는지까지 확인한다. */
export function checkCatalog(items: CatalogItem[]): string[] {
  const ids = new Set(items.map((i) => i.id));
  const errors: string[] = [];
  if (ids.size !== items.length) errors.push('카탈로그에 중복된 id가 있음');
  for (const it of items) {
    for (const a of it.alternatives) if (!ids.has(a.id)) errors.push(`${it.id}: 없는 대안 ${a.id}`);
  }
  return errors;
}

export function checkProject(p: Project, items: CatalogItem[]): string[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const nodeIds = new Set(p.nodes.map((n) => n.id));
  const errors: string[] = [];
  for (const n of p.nodes) {
    for (const id of [n.primary, ...n.extras].filter((x): x is string => !!x)) {
      const it = byId.get(id);
      if (!it) errors.push(`${n.id}: 없는 카탈로그 항목 ${id}`);
      else if (!it.attaches_to.includes(n.layer)) errors.push(`${n.id}: ${id}는 ${n.layer} 노드에 붙일 수 없음`);
    }
    if (n.primary && byId.get(n.primary)?.role === '보조') errors.push(`${n.id}: ${n.primary}는 보조 항목이라 주 항목이 될 수 없음`);
  }
  for (const e of p.edges) {
    if (!nodeIds.has(e.from) || !nodeIds.has(e.to)) errors.push(`연결선 ${e.from} → ${e.to}: 없는 노드`);
  }
  return errors;
}
