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

/** 9절 계량 항목: 대수×시간·월 정액(provisioned/plan), 사용량(usage) */
export const METERS = ['instance', 'vcpu_second', 'gb_second', 'million_requests', 'tb_scanned', 'month'] as const;
export const Billing = z.object({
  model: z.enum(['provisioned', 'usage', 'plan']),
  products: z.partialRecord(z.enum(METERS), z.string()),
});

/** 저장 기능을 켰을 때 크기 계산에 주는 영향. 압축률처럼 데이터에 따라 크게 다른 값은 예시값이다 */
const StorageEffect = z.object({
  /** 압축 후 크기 비율 (0~1) */
  compression: z.number().gt(0).max(1).optional(),
  /** 압축이 걸리는 범위: text = 문자열·JSON·바이너리 컬럼만, all = 행 전체 */
  compression_scope: z.enum(['text', 'all']).optional(),
  /** 이 크기(바이트)를 넘는 행에만 압축이 걸림 (PostgreSQL TOAST 등) */
  applies_above_row_bytes: z.number().positive().optional(),
  table_fill: z.number().gt(0).max(1).optional(),
  index_fill: z.number().gt(0).max(1).optional(),
  /** 바뀌거나 지운 데이터를 이 일수만큼 더 보관(과금) — Time Travel·Fail-safe·VACUUM 보관 */
  extra_retention_days: z.number().nonnegative().optional(),
  /** 행마다 더 붙는 바이트 (DynamoDB 글로벌 테이블 48바이트 등) */
  row_overhead_delta: z.number().optional(),
});
export const StorageFeature = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/),
  group: z.string(),
  label: z.string(),
  /** 시스템 기본값이거나 공식 문서가 권하는 것. 사용자가 고르지 않으면 이것들이 켜진다 */
  recommended: z.boolean().default(false),
  effect: StorageEffect.default({}),
  note: z.string().optional(),
  source: z.string().min(1),
});
/** 시스템의 저장 방식과 고를 수 있는 기능. 테이블 크기 계산의 기준 */
export const StorageProfile = z.object({
  layout: z.enum(['row', 'columnar', 'document', 'kv']),
  /** 행 1개당 고정 오버헤드(헤더·포인터) 바이트 */
  row_overhead_bytes: z.number().nonnegative(),
  /** 컬럼 1개당 오버헤드(타입·길이 표시) 바이트 */
  per_column_overhead_bytes: z.number().nonnegative().default(0),
  index_entry_overhead_bytes: z.number().nonnegative().default(0),
  /** 행마다 컬럼(필드) 이름도 저장 (MongoDB·DynamoDB) */
  stores_field_names: z.boolean().default(false),
  /** 보조 인덱스가 기본 키 값을 함께 저장 (InnoDB) */
  secondary_index_includes_pk: z.boolean().default(false),
  table_fill: z.number().gt(0).max(1).default(1),
  index_fill: z.number().gt(0).max(1).default(1),
  /** 기능 묶음. one이면 그 묶음에서 하나만 고른다 */
  groups: z.record(z.string(), z.object({ label: z.string(), one: z.boolean() })),
  features: z.array(StorageFeature).default([]),
  note: z.string().optional(),
  sources: z.array(z.string()).min(1),
}).superRefine((sp, ctx) => {
  for (const f of sp.features) if (!sp.groups[f.group]) ctx.addIssue({ code: 'custom', message: `기능 ${f.id}: 없는 묶음 ${f.group}`, path: ['features'] });
  for (const [g, def] of Object.entries(sp.groups)) {
    if (def.one && sp.features.filter((f) => f.group === g && f.recommended).length > 1) ctx.addIssue({ code: 'custom', message: `묶음 ${g}: 하나만 고르는 묶음에 권장이 둘 이상`, path: ['groups'] });
  }
});
export type StorageProfile = z.infer<typeof StorageProfile>;
export type StorageFeature = z.infer<typeof StorageFeature>;

export const CatalogItem = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/),
  name: z.string(),
  area: z.enum(['서비스', '스키마·메타', '어플리케이션', '파이프라인']),
  role: z.enum(['주', '보조']),
  kind: z.enum(['알고리즘', '도구', '패턴']),
  attaches_to: z.array(Layer).min(1),
  /** 노드 카드 '동작 방식'에 쓰는 한 줄 설명 */
  summary: z.string().optional(),
  provides: z.array(z.string()).optional(),
  goals: z.record(z.string(), Grade),
  works_when: z.array(Cond).default([]),
  fails_when: z.array(Cond).default([]),
  alternatives: z.array(z.object({ id: z.string(), better_for: z.array(z.string()), note: z.string().optional() })).default([]),
  settings: z.array(z.object({ name: z.string(), goal: z.string() })).default([]),
  thresholds: z.record(z.string(), Threshold).default({}),
  /** 9절 과금 방식과 계량 항목별 가격표 상품 키 (리전은 노드에서 정한다) */
  billing: Billing.optional(),
  /** 저장 프로필. 같은 엔진을 쓰는 항목(Supabase → PostgreSQL)은 same_as로 가리킨다 */
  storage: z.union([StorageProfile, z.object({ same_as: z.string() })]).optional(),
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

// 9절 가격표: 한국·일본 리전만 받는다
export const REGIONS = [
  'aws:ap-northeast-1', 'aws:ap-northeast-2', 'aws:ap-northeast-3',
  'gcp:asia-northeast1', 'gcp:asia-northeast2', 'gcp:asia-northeast3',
  'azure:koreacentral', 'azure:koreasouth', 'azure:japaneast', 'azure:japanwest',
  'supabase:ap-northeast-1', 'supabase:ap-northeast-2',
] as const;

/** 리전이 있는 나라 (15절 국외 이전 판단) */
export const REGION_COUNTRY: Record<(typeof REGIONS)[number], 'KR' | 'JP'> = {
  'aws:ap-northeast-1': 'JP', 'aws:ap-northeast-2': 'KR', 'aws:ap-northeast-3': 'JP',
  'gcp:asia-northeast1': 'JP', 'gcp:asia-northeast2': 'JP', 'gcp:asia-northeast3': 'KR',
  'azure:koreacentral': 'KR', 'azure:koreasouth': 'KR', 'azure:japaneast': 'JP', 'azure:japanwest': 'JP',
  'supabase:ap-northeast-1': 'JP', 'supabase:ap-northeast-2': 'KR',
};

export const PATTERN_IDS = ['power', 'enthusiast', 'active', 'regular', 'occasional', 'rare', 'dormant'] as const;

// 16절 구동 방식
export const Deploy = z.object({
  mode: z.enum(['local_exe', 'web', 'mobile', 'hybrid', 'server']),
  offline_required: z.boolean().default(false),
  scope: z.enum(['single', 'team', 'public']).default('public'),
  targets: z.array(z.string()).default([]),
  device_spec: Spec.optional(),
});

// 데이터 명세: 테이블·컬럼·인덱스. 크기 계산과 SQLite 실험이 이 정의를 그대로 쓴다
export const COLUMN_TYPES = ['int', 'bigint', 'float', 'numeric', 'bool', 'uuid', 'timestamp', 'date', 'text', 'json', 'bytes'] as const;
/** SQLite 저장 클래스. 같은 시각도 integer(epoch)면 8바이트, text(ISO)면 24바이트처럼 크기가 달라진다 */
export const STORAGE_FORMATS = ['integer', 'real', 'text', 'blob'] as const;
/** 저장 형식을 안 적었을 때 타입별 기본값 */
export const DEFAULT_STORAGE: Record<(typeof COLUMN_TYPES)[number], (typeof STORAGE_FORMATS)[number]> = {
  int: 'integer', bigint: 'integer', bool: 'integer', timestamp: 'integer', date: 'integer',
  float: 'real', numeric: 'real', uuid: 'blob', bytes: 'blob', text: 'text', json: 'text',
};
export const TABLE_LAYERS = ['db', 'cache', 'analytics'] as const;

export const Column = z.object({
  name: z.string().min(1),
  type: z.enum(COLUMN_TYPES),
  storage: z.enum(STORAGE_FORMATS).optional(),
  /** text·bytes의 최대 길이(바이트) */
  max_length: z.number().int().positive().optional(),
  /** 실제 값의 평균 바이트. 없으면 크기 계산에서 가정값을 쓰고 그렇다고 표시한다 */
  avg_bytes: z.number().positive().optional(),
  nullable: z.boolean().default(false),
  description: z.string().optional(),
});
export const Table = z.object({
  name: z.string().min(1),
  columns: z.array(Column).min(1),
  primary_key: z.array(z.string()).default([]),
  indexes: z.array(z.object({ name: z.string().min(1), columns: z.array(z.string()).min(1), unique: z.boolean().default(false) })).default([]),
  /** 없으면 scale.retention_days */
  retention_days: z.number().positive().optional(),
  /** 쓰기 중 새 행이 아니라 기존 행을 고치는 비율 */
  update_ratio: z.number().min(0).max(1).default(0),
  partition: z.object({ column: z.string(), interval: z.enum(['day', 'week', 'month']) }).optional(),
  /** 이 테이블만 다르게 켤 저장 기능 id. 없으면 노드 선택을 따른다 */
  storage_features: z.array(z.string()).optional(),
  /** SQLite 실험이나 운영에서 잰 값. 있으면 계산값보다 우선한다 */
  measured: z.object({
    row_bytes: z.number().positive().optional(),
    index_bytes: z.number().nonnegative().optional(),
    rows_per_day: z.number().nonnegative().optional(),
  }).default({}),
});
export type Column = z.infer<typeof Column>;
export type Table = z.infer<typeof Table>;

/** 사용자 행동 1회가 어느 테이블에 몇 행을 쓰는지. 페르소나별 빈도로 테이블 데이터량이 나온다 */
export const Action = z.object({
  name: z.string().min(1),
  /** 접속 1회당 평균 횟수 (페르소나의 action_rates가 덮어씀) */
  per_session: z.number().nonnegative(),
  writes: z.array(z.object({ node: z.string(), table: z.string(), rows: z.number().positive().default(1) })).min(1),
});
export type Action = z.infer<typeof Action>;

// 4절 페르소나: 사용 패턴(프리셋) + 비율. 패턴 값은 필드별로 덮어쓸 수 있다. 크기 단위 KB = 1,000바이트
export const Persona = z.object({
  name: z.string(),
  share: z.number().min(0).max(1),
  pattern: z.enum(PATTERN_IDS),
  // 포아송 추첨(exp(−λ))이 λ가 수백이면 0으로 넘쳐 틀린 값을 내므로 상한을 둔다
  sessions_per_day: z.number().nonnegative().max(100).optional(),
  reads_per_session: z.number().nonnegative().optional(),
  writes_per_session: z.number().nonnegative().optional(),
  session_minutes: z.number().nonnegative().optional(),
  write_kb: z.number().nonnegative().optional(),
  response_kb: z.number().nonnegative().optional(),
  /** 하이브리드에서 접속 1회당 동기화 요청 수 (요청 1건 = 쓰기 1건) */
  sync_per_session: z.number().nonnegative().optional(),
  /** 행동 이름 → 접속 1회당 횟수. 없는 행동은 action.per_session */
  action_rates: z.record(z.string(), z.number().nonnegative()).default({}),
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
    /** 노드 카드 '설명'에 쓰는 사람이 쓴 설명 */
    description: z.string().optional(),
    primary: z.string().optional(),
    extras: z.array(z.string()).default([]),
    spec: Spec.optional(),
    /** 화면 노드가 여럿일 때 이 노드로 들어오는 트래픽 비율. 없으면 화면 노드끼리 균등 */
    entry_share: z.number().min(0).max(1).optional(),
    /** 기준값 이름 → 실측값. 있으면 업계 기준값·사양 보정보다 우선한다 */
    measured: z.record(z.string(), z.number()).default({}),
    /** 엔진이 계산하지 않는 판정 변수(처리 시간 편차 등)나 계산값을 덮어쓸 실측값 */
    vars: z.object({ normal: Vars, event: Vars }).default({ normal: {}, event: {} }),
    /** 12절 지연시간: 요청 1건 평균 처리 시간, 대당 동시 처리 수, (있으면) 실측 처리 p99 */
    perf: z.object({ service_ms: z.number().positive(), workers: z.number().int().positive(), service_p99_ms: z.number().positive().optional() }).optional(),
    /** 13절 이중화 대수(하나만 살아 있어도 동작). 1이면 단일 장애점 */
    replicas: z.number().int().positive().default(1),
    /** 13절 1대의 가용성. 없으면 project.default_availability */
    availability: z.number().min(0).max(1).optional(),
    /** 9절 가격표의 인스턴스 상품 id (시간당 과금 또는 월 정액) */
    price: z.string().optional(),
    /** 15절 이 노드가 데이터를 두는 곳: 클라우드 리전 또는 사용자 기기(local) */
    region: z.union([z.enum(REGIONS), z.literal('local')]).optional(),
    /** 15절 개인정보 속성. 사람이 확정한다(코드 분석은 후보만 표시) */
    privacy: z.object({
      personal: z.boolean().default(false),
      sensitive: z.boolean().default(false),
      unique_id: z.boolean().default(false),
      /** 데이터 주체의 나라 (KR, JP …) */
      subjects: z.array(z.string().regex(/^[A-Z]{2}$/)).default([]),
      /** 개인정보를 외부 연동(제3자)으로 보냄 */
      sends_external: z.boolean().default(false),
    }).optional(),
    /** 6단계 HTML 와이어프레임에서 뽑은 화면 영역 */
    html: z.object({ file: z.string(), regions: z.array(z.object({ role: z.string(), selector: z.string(), controls: z.array(z.string()) })) }).optional(),
    min_instances: z.number().int().nonnegative().default(1),
    /** 9절 계산으로 알 수 없는 사용량 (분석 노드의 월 스캔량 등) */
    usage: z.object({ scanned_tb_month: z.number().nonnegative().optional() }).default({}),
    /** 주 항목 저장 프로필에서 켠 기능 id. 없으면 권장 기능 */
    storage_features: z.array(z.string()).optional(),
    /** 이 노드에 저장되는 테이블 (db·cache·analytics 노드) */
    tables: z.array(Table).default([]),
  })),
  actions: z.array(Action).default([]),
  edges: z.array(z.object({
    from: z.string(),
    to: z.string(),
    sync: z.boolean().default(true),
    callRatio: z.number().nonnegative().default(1),
    /** 이 연결로 흐르는 요청 종류. read면 쓰기는 넘어가지 않는다 */
    carries: z.enum(['all', 'read', 'write']).default('all'),
    /** 12절 이 구간의 왕복 지연(ms) */
    rtt_ms: z.number().nonnegative().default(0),
  })).default([]),
  /** 9절 목표 사용률: 필요 대수 = ceil(부하 / (대당 처리량 × 이 값)) */
  target_utilization: z.number().gt(0).max(1).default(0.7),
  // 예시값: 실제 가용성은 각 클라우드의 SLA 문서로 노드마다 넣는다
  default_availability: z.number().min(0).max(1).default(0.999),
  /** 9절 프로젝트 단위 과금 상품 id */
  cost: z.object({
    /** 노드에 리전이 없을 때 쓰는 기본 리전 */
    region: z.enum(REGIONS).optional(),
    storage: z.string().optional(),
    egress: z.string().optional(),
    /** 리전이 다른 노드 사이 전송 상품 */
    transfer: z.string().optional(),
  }).default({}),
  /** 10절 최선 조합: 꼭 지킬 조건과 목표 우선순위(앞일수록 중요, 비우면 모든 목표 같은 가중치) */
  optimize: z.object({
    budget_monthly: z.number().nonnegative().optional(),
    min_limit_users: z.number().positive().optional(),
    max_p99_ms: z.number().positive().optional(),
    min_availability: z.number().min(0).max(1).optional(),
    priorities: z.array(z.string()).default([]),
  }).default({ priorities: [] }),
  /** 14절 월 성장률, 보는 기간, 교체 준비 기간 */
  growth: z.object({ monthly_rate: z.number().gt(-1), months: z.number().int().positive().default(24), lead_months: z.number().int().nonnegative().default(3) }).optional(),
});


export const PriceRow = z.object({
  id: z.string(),
  region: z.enum(REGIONS),
  /** 리전과 무관한 상품 키 (예: vm-2vcpu). 카탈로그 billing.products와 노드 리전으로 찾는다. 없으면 id */
  product: z.string().optional(),
  /** hour = 대당 시간, month = 대당 월 정액, gb_month = 저장 GB·월, gb = 인터넷 송신 GB, gb_interregion = 리전 간 전송 GB,
   *  vcpu_second·gb_second = 연산 사용량, million_requests = 요청 100만 건, tb_scanned = 스캔 TB */
  unit: z.enum(['hour', 'month', 'gb_month', 'gb', 'gb_interregion', 'vcpu_second', 'gb_second', 'million_requests', 'tb_scanned']),
  price: z.number().nonnegative(),
  currency: z.string().length(3),
  as_of: z.iso.date(),
  source: z.string().min(1),
});

export type Spec = z.infer<typeof Spec>;
export type Threshold = z.infer<typeof Threshold>;
export type CatalogItem = z.infer<typeof CatalogItem>;
export type Rule = z.infer<typeof Rule>;
export type Project = z.infer<typeof Project>;
/** 화면에서 노드·연결선을 새로 만들 때 기본값을 채우는 데 쓴다 */
export const NodeSchema = Project.shape.nodes.element;
export const EdgeSchema = Project.shape.edges.unwrap().element;
export type ProjectEdge = Project['edges'][number];
export type ProjectNode = Project['nodes'][number];
export type Deploy = z.infer<typeof Deploy>;
export type PriceRow = z.infer<typeof PriceRow>;
export type Persona = z.infer<typeof Persona>;

/** 카탈로그 전체를 검증하고, 대안·프로젝트가 가리키는 id가 실제로 있는지까지 확인한다. */
export function checkCatalog(items: CatalogItem[]): string[] {
  const ids = new Set(items.map((i) => i.id));
  const errors: string[] = [];
  if (ids.size !== items.length) errors.push('카탈로그에 중복된 id가 있음');
  for (const it of items) {
    for (const a of it.alternatives) if (!ids.has(a.id)) errors.push(`${it.id}: 없는 대안 ${a.id}`);
    if (it.storage && 'same_as' in it.storage) {
      const target = items.find((x) => x.id === (it.storage as { same_as: string }).same_as);
      if (!target?.storage || 'same_as' in target.storage) errors.push(`${it.id}: same_as는 프로필이 있는 항목을 가리켜야 함`);
    }
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
  for (const n of p.nodes) errors.push(...n.tables.flatMap((t) => checkTable(t).map((e) => `${n.id}.${t.name}: ${e}`)));
  for (const n of p.nodes) {
    if (n.tables.length && !(TABLE_LAYERS as readonly string[]).includes(n.layer)) errors.push(`${n.id}: 테이블은 ${TABLE_LAYERS.join('·')} 노드에만 둘 수 있음`);
    for (const d of dupes(n.tables.map((t) => t.name))) errors.push(`${n.id}: 테이블 이름 중복 ${d}`);
  }
  for (const d of dupes(p.actions.map((a) => a.name))) errors.push(`행동 이름 중복 ${d}`);
  for (const a of p.actions) {
    for (const w of a.writes) {
      const node = p.nodes.find((n) => n.id === w.node);
      if (!node) errors.push(`행동 ${a.name}: 없는 노드 ${w.node}`);
      else if (!node.tables.some((t) => t.name === w.table)) errors.push(`행동 ${a.name}: ${w.node}에 없는 테이블 ${w.table}`);
    }
  }
  for (const n of p.nodes) {
    const sp = storageProfileOf(n.primary ? byId.get(n.primary) : undefined, byId);
    const pick = (where: string, ids: string[] | undefined) => {
      if (!ids) return;
      if (!sp) return errors.push(`${where}: 주 항목에 저장 프로필이 없어 저장 기능을 고를 수 없음`);
      for (const id of ids) if (!sp.features.some((f) => f.id === id)) errors.push(`${where}: 없는 저장 기능 ${id}`);
      for (const [g, def] of Object.entries(sp.groups)) {
        if (def.one && sp.features.filter((f) => f.group === g && ids.includes(f.id)).length > 1) errors.push(`${where}: ${def.label}은 하나만 고를 수 있음`);
      }
    };
    pick(n.id, n.storage_features);
    for (const t of n.tables) pick(`${n.id}.${t.name}`, t.storage_features);
  }
  const actionNames = new Set(p.actions.map((a) => a.name));
  for (const ps of p.personas) {
    for (const k of Object.keys(ps.action_rates)) if (!actionNames.has(k)) errors.push(`페르소나 ${ps.name}: 없는 행동 ${k}`);
    if (p.actions.length && ps.writes_per_session !== undefined) errors.push(`페르소나 ${ps.name}: 행동이 있으면 쓰기 수는 행동 빈도로 정해짐 (writes_per_session 대신 action_rates)`);
  }
  return errors;
}

const dupes = (xs: string[]) => [...new Set(xs.filter((x, i) => xs.indexOf(x) !== i))];

/** 테이블 하나의 내부 참조(키·인덱스·파티션 컬럼)가 실제 컬럼인지 */
export function checkTable(t: Table): string[] {
  const cols = new Set(t.columns.map((c) => c.name));
  const errors = dupes(t.columns.map((c) => c.name)).map((d) => `컬럼 이름 중복 ${d}`);
  for (const c of t.primary_key) if (!cols.has(c)) errors.push(`기본 키에 없는 컬럼 ${c}`);
  for (const ix of t.indexes) for (const c of ix.columns) if (!cols.has(c)) errors.push(`인덱스 ${ix.name}에 없는 컬럼 ${c}`);
  for (const d of dupes(t.indexes.map((x) => x.name))) errors.push(`인덱스 이름 중복 ${d}`);
  if (t.partition && !cols.has(t.partition.column)) errors.push(`파티션에 없는 컬럼 ${t.partition.column}`);
  return errors;
}

// 15절 법령 표: 조문 내용은 넣지 않고 번호·트리거·출처만 둔다
export const LawRow = z.object({
  id: z.string(),
  law: z.string(),
  article: z.string(),
  /** 노드 개인정보 속성으로 쓴 조건식 (personal, sensitive, unique_id, subject_KR, store_country, sends_external …) */
  trigger: Expr,
  /** 걸린 이유(설계 기준). {store_country} 같은 변수를 넣을 수 있다 */
  reason: z.string().min(1),
  as_of: z.iso.date(),
  source: z.string().min(1),
  /** 원문과 대조했는지. false면 화면에 '조문 번호 미확인'으로 표시 */
  verified: z.boolean(),
});
export type LawRow = z.infer<typeof LawRow>;

/** 항목의 저장 프로필 (same_as를 따라간다) */
export function storageProfileOf(item: CatalogItem | undefined, byId: Map<string, CatalogItem>): StorageProfile | undefined {
  const st = item?.storage;
  if (!st) return undefined;
  if (!('same_as' in st)) return st;
  const target = byId.get(st.same_as)?.storage;
  return target && !('same_as' in target) ? target : undefined;
}

/** 실제로 켜진 기능: 테이블 선택 → 노드 선택 → 권장 기능 순 */
export function selectedFeatures(sp: StorageProfile, node: { storage_features?: string[] }, table?: { storage_features?: string[] }): StorageFeature[] {
  const ids = table?.storage_features ?? node.storage_features;
  return ids ? sp.features.filter((f) => ids.includes(f.id)) : sp.features.filter((f) => f.recommended);
}
