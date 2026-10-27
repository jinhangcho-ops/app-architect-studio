// 사람이 고치는 JSON 파일(카탈로그·규칙·프로젝트)의 검증. 조건식은 읽을 때 미리 해석해 오류를 일찍 잡는다.
import { z } from 'zod';
import { parse } from './expr';
import { LAYERS } from './model';
import { STANDARD_OFFSET } from './timezones';
import { INDUSTRY_IDS } from './industry';

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
  /** 기본 키가 테이블 자체라 키 인덱스가 따로 없음 (SQLite WITHOUT ROWID) */
  pk_is_table: z.boolean().optional(),
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
  /** 행이 기본 키 순서로 저장돼 키 인덱스가 따로 없음 (InnoDB 클러스터드 인덱스, DynamoDB) */
  pk_is_table: z.boolean().default(false),
  /** 정수 한 컬럼짜리 기본 키는 행 번호(rowid)로 쓰여 인덱스가 따로 없음 (SQLite) */
  integer_pk_is_rowid: z.boolean().default(false),
  /** 고정 길이 문자열(CHAR(n))을 선언한 길이까지 공백으로 채워 저장 (MySQL·PostgreSQL). false면 고정장으로 선언해도 실제 길이로 저장 */
  fixed_width_padded: z.boolean().default(false),
  /** 고정 길이로 채워 저장하는 최대 길이. 넘으면 가변 길이로 저장 (MySQL CHAR는 255까지, 넘으면 VARCHAR) */
  fixed_width_max: z.number().int().positive().optional(),
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
  /** 늘리는 방식: horizontal = 대수만큼 처리량이 는다(기본), single_primary = 쓰기는 주 서버 1대만 받고 읽기만 읽기 복제본(read_replica)으로 나눈다 */
  scaling: z.enum(['horizontal', 'single_primary']).default('horizontal'),
  /** 저장 프로필. 같은 엔진을 쓰는 항목(Supabase → PostgreSQL)은 same_as로 가리킨다 */
  storage: z.union([StorageProfile, z.object({ same_as: z.string() })]).optional(),
  sources: z.array(z.string()).min(1),
});

export const Rule = z.object({
  id: z.string(),
  scope: z.enum(['edge', 'project', 'table']),
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
  /** 사용자 기기 사양 (memGb로 로컬 메모리 점유율을 낸다) */
  device_spec: Spec.optional(),
  /** 로컬 실행 메모리(MB): 런타임 기본, 시작할 때 올리는 라이브러리, 필요할 때 올리는 라이브러리, 데이터 캐시 */
  memory: z.object({
    runtime_mb: z.number().nonnegative(),
    eager_mb: z.array(z.number().nonnegative()).default([]),
    lazy_mb: z.array(z.number().nonnegative()).default([]),
    cache_mb: z.number().nonnegative().optional(),
  }).optional(),
});

// 와이어프레임: 화면마다 영역·컨트롤 상자 (좌표는 화면 틀 안의 px)
export const WIRE_KINDS = ['header', 'nav', 'sidebar', 'main', 'form', 'table', 'list', 'card', 'modal', 'footer', 'text', 'image', 'button', 'input', 'select', 'tabs',
  'rect', 'ellipse', 'line', 'arrow', 'icon', 'avatar', 'checkbox', 'radio', 'toggle'] as const;
/** 화면 틀 기기 */
export const WIRE_DEVICES = ['desktop', 'tablet', 'tablet_land', 'mobile'] as const;
/** 상자 색 (채우기·선) */
export const WIRE_COLORS = ['gray', 'blue', 'green', 'amber', 'red', 'dark'] as const;
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export const WireItem = z.object({
  id: z.string(),
  kind: z.enum(WIRE_KINDS),
  label: z.string().default(''),
  x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive(),
  color: z.enum(WIRE_COLORS).optional(),
  /** 이 컨트롤이 부르는 API. to = 받는 노드 id (연결선이 있어야 부하가 간다), per_session = 접속 1회당 횟수 (호출끼리 나누는 비율) */
  api: z.object({
    method: z.enum(HTTP_METHODS).default('GET'),
    path: z.string().default(''),
    to: z.string().optional(),
    per_session: z.number().nonnegative().default(1),
  }).optional(),
});
// 서비스 내부 인터페이스 명세: 연결선마다 주고받는 호출·메시지. OpenAPI(REST)·AsyncAPI(메시지)·proto(gRPC)로 내보내고, 호출 수와 크기는 부하·전송량 계산에 쓴다
export const FIELD_TYPES = ['string', 'integer', 'number', 'boolean', 'datetime', 'uuid', 'object', 'array'] as const;
export const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const SpecField = z.object({
  /** 영문 식별자 (코드 생성 도구가 그대로 쓴다) */
  name: z.string().regex(IDENT, '필드 이름은 영문·숫자·_ (숫자로 시작하지 않음)'),
  type: z.enum(FIELD_TYPES),
  required: z.boolean().default(true),
  description: z.string().optional(),
  /** 값의 평균 크기(바이트). 없으면 형식별 예시값 */
  avg_bytes: z.number().positive().optional(),
  /** 고정장 레이아웃(파일·전문)에서 이 필드가 차지하는 바이트 */
  length: z.number().int().positive().optional(),
});
export type SpecField = z.infer<typeof SpecField>;
/** 파일·전문의 장 형식: fixed = 고정장(필드마다 바이트 길이, 숫자는 앞을 0으로·문자는 뒤를 공백으로 채움), delimited = 가변장(구분자) */
export const FileRecord = z.object({
  format: z.enum(['fixed', 'delimited']),
  delimiter: z.string().min(1).max(3).default(','),
  encoding: z.enum(['utf-8', 'euc-kr']).default('utf-8'),
  newline: z.enum(['crlf', 'lf', 'none']).default('crlf'),
  /** 가변장의 첫 줄에 필드 이름 머리줄이 있는지 */
  header: z.boolean().default(false),
});
export type FileRecord = z.infer<typeof FileRecord>;
export const Interface = z.object({
  /** 사람이 읽는 이름 (예: 주문 만들기) */
  name: z.string().min(1),
  /** rest = HTTP API, grpc = gRPC 메서드, message = 큐·이벤트로 보내는 메시지, file = 파일·전문(배치 파일, 기관 연계 고정장 전문) */
  kind: z.enum(['rest', 'grpc', 'message', 'file']),
  method: z.enum(HTTP_METHODS).optional(),
  /** rest: 경로(/orders/{id}), grpc: 메서드 이름(CreateOrder), message: 토픽·채널 이름, file: 파일 이름 규칙이나 전문 ID */
  path: z.string().min(1),
  description: z.string().optional(),
  /** 보내는 노드가 받는 요청 1건당 이 인터페이스를 부르는 횟수. on = 어떤 요청에서 부르나 (전체·읽기 요청만·쓰기 요청만) */
  per_request: z.number().nonnegative().default(1),
  on: z.enum(['all', 'read', 'write']).default('all'),
  /** 읽기인지 쓰기인지. 없으면 rest는 GET만 읽기, message는 쓰기, grpc는 읽기 */
  op: z.enum(['read', 'write']).optional(),
  request: z.array(SpecField).default([]),
  response: z.array(SpecField).default([]),
  /** 실측한 요청·응답 크기(바이트). 있으면 필드로 어림한 값보다 우선 */
  request_bytes: z.number().nonnegative().optional(),
  response_bytes: z.number().nonnegative().optional(),
  /** 인증: none = 없음, bearer = Authorization: Bearer 토큰(JWT 등), api_key = X-API-Key 헤더. 없으면 미정 (명세 점검이 알린다) */
  auth: z.enum(['none', 'bearer', 'api_key']).optional(),
  /** 파일·전문의 장 형식과 인코딩 (kind가 file일 때) */
  record: FileRecord.optional(),
  /** 이 기능(API·메시지·파일)이 읽고 쓰는 테이블. 기능별 테이블 표와 데이터 사전에 쓴다 (부하 계산에는 쓰지 않음) */
  tables: z.array(z.object({ node: z.string(), table: z.string(), op: z.enum(['read', 'write']) })).optional(),
  /** 실패할 때 돌려주는 응답. 본문은 모두 같은 형식(RFC 9457 problem details: type·title·status·detail·code) */
  errors: z.array(z.object({
    status: z.number().int().min(400).max(599),
    /** 앱이 정한 에러 코드 (예: SALES_DUPLICATE) */
    code: z.string().regex(/^[A-Za-z0-9_.-]+$/, '에러 코드는 영문·숫자·_.-').optional(),
    description: z.string().min(1),
  })).default([]),
});
export type Interface = z.infer<typeof Interface>;

/** device가 없으면 구동 방식으로 정한다 (모바일 → 모바일, 나머지 → 데스크톱) */
export const Screen = z.object({ name: z.string().min(1), device: z.enum(WIRE_DEVICES).optional(), items: z.array(WireItem).default([]) });

// 데이터 명세: 테이블·컬럼·인덱스. 크기 계산과 SQLite 실험이 이 정의를 그대로 쓴다
export const COLUMN_TYPES = ['int', 'bigint', 'float', 'numeric', 'bool', 'uuid', 'timestamp', 'date', 'text', 'json', 'bytes'] as const;
/** SQLite 저장 클래스. 같은 시각도 integer(epoch)면 8바이트, text(ISO)면 24바이트처럼 크기가 달라진다 */
export const STORAGE_FORMATS = ['integer', 'real', 'text', 'blob'] as const;
/** 저장 형식의 화면 이름 */
export const STORAGE_NAMES: Record<(typeof STORAGE_FORMATS)[number], string> = { integer: '정수', real: '실수', text: '문자열', blob: '바이너리' };
/** 저장 형식을 안 적었을 때 타입별 기본값 */
export const DEFAULT_STORAGE: Record<(typeof COLUMN_TYPES)[number], (typeof STORAGE_FORMATS)[number]> = {
  int: 'integer', bigint: 'integer', bool: 'integer', timestamp: 'integer', date: 'integer',
  float: 'real', numeric: 'real', uuid: 'blob', bytes: 'blob', text: 'text', json: 'text',
};
/** 컬럼의 저장 형식 (안 적었으면 타입별 기본값). 크기 계산과 SQLite 실험이 같이 쓴다 */
export const storageOf = (c: { type: (typeof COLUMN_TYPES)[number]; storage?: (typeof STORAGE_FORMATS)[number] }) => c.storage ?? DEFAULT_STORAGE[c.type];
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
  /** 데이터 사전: 논리명(사람이 읽는 이름), 도메인(금액·날짜·코드 같은 값의 종류), 코드 값 목록, 개인정보 여부, 기본값 */
  label: z.string().optional(),
  domain: z.string().optional(),
  codes: z.array(z.object({ code: z.string().min(1), label: z.string().default('') })).optional(),
  personal: z.boolean().default(false),
  default_value: z.string().optional(),
});
/** 장 형식: variable = 가변장(문자열은 실제 길이), fixed = 고정장(문자열·바이너리를 선언 길이 CHAR(n)·BINARY(n)로) */
export const RECORD_FORMATS = ['variable', 'fixed'] as const;
export const Table = z.object({
  name: z.string().min(1),
  /** 데이터 사전: 논리명과 설명 */
  label: z.string().optional(),
  description: z.string().optional(),
  record: z.enum(RECORD_FORMATS).default('variable'),
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
  session_minutes: z.number().nonnegative().max(1440).optional(),
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
  /** 접속 중 창 안에 들어오는 비율. 창 가운데의 정규분포와 하루 전체에 고른 바닥을 섞어 맞춘다(창 끝에서 끊기지 않음). 없으면 scale.window_share */
  window_share: z.number().min(0).max(1).optional(),
  /** 창 안 접속의 모양: 창 반폭 = window_sigma × σ인 정규분포(자르지 않아 창 밖으로 서서히 줄어듦). 클수록 가운데로 더 몰린다 */
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
  /** 업종: 정하면 모든 페르소나가 그 업종의 깨어 있는 창과 피크 시각(industry.ts)을 쓴다. 없으면 페르소나마다 창 가운데 한 봉우리 */
  industry: z.enum(INDUSTRY_IDS).optional(),
  /** 하루 접속 모양을 직접 정한 것 (설정의 "하루 피크"에서 끌어 조정). 있으면 업종 표 대신 이것을 쓴다 */
  day: z.object({
    window: z.tuple([z.number().min(0).max(24), z.number().min(0).max(24)]),
    peaks: z.array(z.object({ at: z.number().min(0).max(24), sd: z.number().min(0.2).max(8), weight: z.number().positive() })).min(1).max(4),
  }).optional(),
  retention_days: z.number().positive().default(365),
  event_multiplier: z.number().min(1).default(1),
  overhead_k: z.number().min(1).default(2),
  burst: z.object({ share: z.number().min(0).max(1), window_s: z.number().positive(), requests: z.number().nonnegative() }).optional(),
  /** 고정 대수 큐 소비자의 적체를 계산하는 시간 칸(분). 짧을수록 몇 분짜리 몰림이 적체에 보인다 (자동 확장 소비자는 늘 1분) */
  queue_step_min: z.union([z.literal(1), z.literal(5), z.literal(15), z.literal(60)]).default(60),
  /** 일시적 급증: 하루 count번 무작위 시각(시드가 같으면 같은 시각)에 duration_min분 동안 부하가 산 모양으로 올랐다 내려온다.
   *  가장 높을 때 평소의 height배이고, 갑자기 두 배가 되는 일은 없게 1.5배까지만 받는다 */
  spikes: z.object({
    count: z.number().int().min(1).max(48).default(6),
    duration_min: z.number().int().min(2).max(60).default(10),
    height: z.number().min(1.01).max(1.5).default(1.2),
  }).optional(),
});

/** 데이터 주고받기의 서비스 성격 (추천값을 고르는 기준) */
export const SERVICE_KINDS = ['chat', 'live', 'feed', 'commerce', 'content', 'tracking', 'iot'] as const;
/** 로드밸런서에서 정하는 데이터 주고받기. 트래픽(요청 수·시간대 곡선)과 그 뒤 모든 부하·비용이 이것을 따른다 */
export const Exchange = z.object({
  service: z.enum(SERVICE_KINDS).optional(),
  /** 받기: polling = 앱이 최신화 주기마다 다시 요청, streaming = 연결을 열어 두고 서버가 최신화 주기마다 밀어줌 */
  receive: z.enum(['polling', 'streaming']).default('polling'),
  /** 최신화 주기(초). 없으면 화면을 옮길 때만 받는다 (패턴의 접속당 읽기만) */
  refresh_s: z.number().positive().optional(),
  /** 보내기: realtime = 행동마다 바로, batch = 모았다가 batch_s초마다 한꺼번에 (요청 수는 줄고 쓰는 행 수는 같음) */
  send: z.enum(['realtime', 'batch']).default('realtime'),
  batch_s: z.number().positive().default(60),
});
export type Exchange = z.infer<typeof Exchange>;

/** 설계 메모 장 제목: 설계서·명령줄이 장 번호를 매기므로 앞의 번호(1. · 2) · 5.3)는 뗀다 ("1. 1. 개요"가 되지 않게). 비면 (제목 없음) */
export const chapterTitle = (t: string) => t.trim().replace(/^\d+(\.\d+)*[.)]?\s+/, '') || '(제목 없음)';

export const Project = z.object({
  name: z.string(),
  /** 설계 메모: 장 제목과 본문(가벼운 마크다운). 순서대로 설계서 맨 앞 장들이 된다. 계산에는 쓰지 않는다 */
  notes: z.array(z.object({ title: z.string(), body: z.string() })).default([]),
  deploy: Deploy.default({ mode: 'web', offline_required: false, scope: 'public', targets: [] }),
  scale: Scale.optional(),
  // 비율 합이 1인지는 checkProject가 본다 (화면에서 비율을 하나씩 고치는 중에도 저장 파일이 열리게)
  personas: z.array(Persona).default([]),
  /** 페르소나 비율을 정한 분포 (설정의 "페르소나"에서 봉우리를 끌어 정함). 비율 자체는 personas[].share가 기준이고, 이것은 다시 편집할 때 쓰는 모양이다 */
  persona_mix: z.array(z.object({ mu: z.number().min(0).max(1), sg: z.number().min(0.02).max(1), w: z.number().positive() })).min(1).max(4).optional(),
  nodes: z.array(z.object({
    id: z.string(),
    name: z.string(),
    layer: Layer,
    /** 노드 카드 '설명'에 쓰는 사람이 쓴 설명 */
    description: z.string().optional(),
    primary: z.string().optional(),
    extras: z.array(z.string()).default([]),
    /** requirements.txt 원문 (FastAPI 노드). 내보내는 FastAPI 뼈대가 이 버전들의 문법으로 나온다. 다른 종류로 바꿔도 지우지 않는다 (다시 돌아올 때 그대로) */
    requirements: z.string().optional(),
    /** Python 버전 (3.8, 3.12 …). requirements.txt에는 보통 없어 따로 받는다. 없으면 3.9 이상으로 본다 */
    python: z.string().regex(/^3(\.\d+){1,2}$/, 'Python 버전은 3.12처럼').optional(),
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
    /** 캐시 노드의 적중률 (읽기 중 캐시에서 끝나는 몫). 같은 노드가 부르는 DB의 읽기가 (1 − 적중률)로 준다. 없으면 0.8 (예시값) */
    hit_ratio: z.number().min(0).max(1).optional(),
    /** 이 노드 1대가 DB에 여는 연결 풀 크기. 없으면 10 (HikariCP·node-postgres 기본값) */
    db_pool: z.number().int().positive().optional(),
    /** 큐 노드의 파티션 수 (Kafka·Redpanda). 소비자 병렬 수가 이것을 넘지 못한다. 없으면 제한 없음 */
    partitions: z.number().int().positive().optional(),
    /** 큐 지연 허용(초): 메시지가 들어와 처리될 때까지. 큐 노드나 소비자 노드에 둔다. 없으면 300초 (예시값) */
    max_lag_s: z.number().positive().optional(),
    /** 정해진 주기로 도는 배치: every_min분마다 그동안 들어온 양을 한 번에 처리하고, window_min분(없으면 주기) 안에 끝나야 한다 */
    batch: z.object({ every_min: z.number().positive(), window_min: z.number().positive().optional() }).optional(),
    /** 큐 소비자 자동 확장(KEDA 같은 것): 트래픽에 맞춰 대수를 정한다. 최소 = min_instances(0이면 한가할 때 끔), max = 최대 대수,
     *  delay_s = 새 소비자가 처리를 시작하기까지(예시값 30초), poll_s = 확인 주기(KEDA pollingInterval), cooldown_s = 줄이기 전 기다림(KEDA cooldownPeriod) */
    autoscale: z.object({
      max: z.number().int().positive().optional(), delay_s: z.number().nonnegative().optional(),
      poll_s: z.number().positive().optional(), cooldown_s: z.number().nonnegative().optional(),
    }).optional(),
    /** 서버를 나눠 둔 가용 영역(존) 수. 없으면 1 (존 하나가 멈추면 이 노드도 멈춤) */
    zones: z.number().int().positive().optional(),
    /** 다른 리전 복사본. active = 두 리전이 같이 받음, standby = 대기 중인 복사본으로 넘김, backup = 다른 리전에 둔 백업에서 되살림.
     *  rto_s: 넘기는 데 걸리는 시간(실측), lag_s: 복제 지연(그만큼 데이터를 잃음), instances: standby가 평소 띄워 두는 대수(없으면 1) */
    dr: z.object({
      region: z.enum(REGIONS), mode: z.enum(['active', 'standby', 'backup']),
      rto_s: z.number().positive().optional(), lag_s: z.number().nonnegative().optional(),
      instances: z.number().int().positive().optional(),
    }).optional(),
    /** 데이터 노드 백업: every_h시간마다, pitr = 시점 복구(로그를 계속 보관), restore_mb_s = 되살리는 속도 */
    backup: z.object({ every_h: z.number().positive(), pitr: z.boolean().default(false), restore_mb_s: z.number().positive().optional() }).optional(),
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
    /** 화면 노드의 와이어프레임 (UI/UX 설계). 계산에는 쓰지 않는다 */
    wireframe: z.object({ screens: z.array(Screen) }).optional(),
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
    /** 이 연결로 주고받는 인터페이스 명세. 있으면 호출 비율·흐르는 요청 대신 이것으로 부하를 나눈다 */
    interfaces: z.array(Interface).default([]),
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
  /** 장애 목표: 견딜 장애(존·리전), 복구 목표 시간(RTO), 잃어도 되는 데이터 시간(RPO). 있을 때만 판정에 넣는다 */
  recovery: z.object({
    survive: z.enum(['none', 'zone', 'region']).default('none'),
    rto_min: z.number().positive().optional(),
    rpo_min: z.number().nonnegative().optional(),
  }).optional(),
  /** 14절 월 성장률, 보는 기간, 교체 준비 기간 */
  exchange: Exchange.optional(),
  growth: z.object({
    monthly_rate: z.number().gt(-1), months: z.number().int().positive().max(240).default(24), lead_months: z.number().int().nonnegative().default(3),
    /** 14절 유입 모형. 있으면 월 성장률 대신 이것으로 달마다 사용자 수를 계산한다.
     *  유입: Bass 확산 — 바깥 유입(광고·검색) = external × 남은 시장, 입소문 = word_of_mouth × (써 본 사람 / 시장) × 남은 시장.
     *  새 사용자는 entry 페르소나로 들어오고, 달마다 up만큼 한 단계 더 활발한 페르소나로, down만큼 한 단계 덜 활발한 페르소나로 옮기며,
     *  가장 덜 활발한 페르소나에서 leave만큼 떠난다 (페르소나 단계 = 사용 패턴의 활발한 순서) */
    inflow: z.object({
      market: z.number().positive(),
      external: z.number().min(0).max(1),
      word_of_mouth: z.number().min(0).max(2),
      entry: z.string(),
      up: z.number().min(0).max(1).default(0.05),
      down: z.number().min(0).max(1).default(0.03),
      leave: z.number().min(0).max(1).default(0.1),
    }).optional(),
  }).optional(),
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
export type WireItem = z.infer<typeof WireItem>;
export type Screen = z.infer<typeof Screen>;
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
  // 노드 id가 겹치면 연결선이 어느 노드인지 몰라 순환처럼 보이므로 맨 먼저 알린다
  const errors: string[] = dupes(p.nodes.map((n) => n.id)).map((d) => `노드 id 중복 ${d}`);
  // 같은 출발·도착 연결선이 둘이면 화면에서 하나만 고르거나 지울 수 없다 (화면은 from->to를 연결선 id로 쓴다)
  for (const d of dupes(p.edges.map((e) => `${e.from}->${e.to}`))) errors.push(`연결선 중복 ${d}`);
  // 정한 몫만의 합이 1을 넘으면 사용자 수보다 많은 요청이 들어온다 (비운 칸은 load.ts가 남은 몫을 나눠 주므로 오류를 만들지 않음)
  const shareSum = entryNodes(p).reduce((s, n) => s + (n.entry_share ?? 0), 0);
  if (shareSum > 1 + 1e-9) errors.push(`화면 노드 진입 몫(entry_share) 합이 1을 넘음 (${+shareSum.toFixed(4)})`);
  const personaSum = p.personas.reduce((s, ps) => s + ps.share, 0);
  if (p.personas.length && Math.abs(personaSum - 1) >= 1e-6) errors.push(`페르소나 비율의 합은 1이어야 함 (지금 ${+personaSum.toFixed(4)})`);
  for (const n of p.nodes) {
    for (const id of itemIds(n)) {
      const it = byId.get(id);
      if (!it) errors.push(`${n.id}: 없는 카탈로그 항목 ${id}`);
      else if (!it.attaches_to.includes(n.layer)) errors.push(`${n.id}: ${id}는 ${n.layer} 노드에 붙일 수 없음`);
    }
    if (n.primary && byId.get(n.primary)?.role === '보조') errors.push(`${n.id}: ${n.primary}는 보조 항목이라 주 항목이 될 수 없음`);
  }
  for (const e of p.edges) {
    if (!nodeIds.has(e.from) || !nodeIds.has(e.to)) errors.push(`연결선 ${e.from} → ${e.to}: 없는 노드`);
    const at = `연결선 ${e.from} → ${e.to}`;
    for (const d of dupes(e.interfaces.map((i) => i.name))) errors.push(`${at}: 인터페이스 이름 중복 ${d}`);
    for (const i of e.interfaces) {
      if (i.kind === 'rest' && !i.method) errors.push(`${at} ${i.name}: REST는 메서드(GET·POST…)가 필요함`);
      if ((i.kind === 'message' || i.kind === 'file') && i.response.length) errors.push(`${at} ${i.name}: ${i.kind === 'file' ? '파일·전문' : '메시지'}은 응답이 없음 (보내고 끝)`);
      for (const d of dupes(i.errors.map((x) => `${x.status}${x.code ? ` ${x.code}` : ''}`))) errors.push(`${at} ${i.name}: 에러 응답 중복 ${d}`);
      for (const t of i.tables ?? []) {
        const node = p.nodes.find((n) => n.id === t.node);
        if (!node) errors.push(`${at} ${i.name}: 없는 노드 ${t.node}`);
        else if (!node.tables.some((x) => x.name === t.table)) errors.push(`${at} ${i.name}: ${t.node}에 없는 테이블 ${t.table}`);
      }
      for (const side of ['request', 'response'] as const) for (const d of dupes(i[side].map((f) => f.name))) errors.push(`${at} ${i.name}: ${side === 'request' ? '요청' : '응답'} 필드 이름 중복 ${d}`);
    }
  }
  for (const n of p.nodes) {
    for (const sc of n.wireframe?.screens ?? []) {
      for (const it of sc.items) if (it.api?.to && !nodeIds.has(it.api.to)) errors.push(`${n.id} ${sc.name} ${it.label || it.id}: API 대상 노드 ${it.api.to}가 없음`);
    }
  }
  for (const n of p.nodes) errors.push(...n.tables.flatMap((t) => checkTable(t).map((e) => `${n.id}.${t.name}: ${e}`)));
  for (const n of p.nodes) {
    if (n.tables.length && !(TABLE_LAYERS as readonly string[]).includes(n.layer)) errors.push(`${n.id}: 테이블은 ${TABLE_LAYERS.join('·')} 노드에만 둘 수 있음`);
    for (const d of dupes(n.tables.map((t) => t.name))) errors.push(`${n.id}: 테이블 이름 중복 ${d}`);
  }
  for (const d of dupes(p.actions.map((a) => a.name))) errors.push(`행동 이름 중복 ${d}`);
  const inflow = p.growth?.inflow;
  if (inflow && !p.personas.some((ps) => ps.name === inflow.entry)) errors.push(`유입 모형: 새 사용자가 들어올 페르소나 ${inflow.entry}가 없음`);
  if (inflow && p.scale && inflow.market < p.scale.users) errors.push('유입 모형: 시장 크기가 지금 활성 사용자보다 작음');
  // 한 단계에서 한 달에 나가는 몫이 1을 넘으면 없던 사람이 생긴다
  if (inflow && (inflow.up + inflow.down > 1 || inflow.up + inflow.leave > 1)) errors.push('유입 모형: 더 활발해짐 + 덜 쓰게 됨(또는 떠남)이 한 달에 1을 넘음');
  for (const a of p.actions) {
    for (const w of a.writes) {
      const node = p.nodes.find((n) => n.id === w.node);
      if (!node) errors.push(`행동 ${a.name}: 없는 노드 ${w.node}`);
      else if (!node.tables.some((t) => t.name === w.table)) errors.push(`행동 ${a.name}: ${w.node}에 없는 테이블 ${w.table}`);
    }
  }
  for (const n of p.nodes) {
    const sp = nodeStorageProfile(n, byId);
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

export const dupes = (xs: string[]) => [...new Set(xs.filter((x, i) => xs.indexOf(x) !== i))];

/** 테이블 하나의 내부 참조(키·인덱스·파티션 컬럼)가 실제 컬럼인지. 기본값·코드 값의 타입은 막지 않는 경고(ddl.ts schemaWarnings) */
export function checkTable(t: Table): string[] {
  const cols = new Set(t.columns.map((c) => c.name));
  const errors = dupes(t.columns.map((c) => c.name)).map((d) => `컬럼 이름 중복 ${d}`);
  for (const c of t.primary_key) if (!cols.has(c)) errors.push(`기본 키에 없는 컬럼 ${c}`);
  for (const ix of t.indexes) for (const c of ix.columns) if (!cols.has(c)) errors.push(`인덱스 ${ix.name}에 없는 컬럼 ${c}`);
  for (const d of dupes(t.indexes.map((x) => x.name))) errors.push(`인덱스 이름 중복 ${d}`);
  if (t.partition && !cols.has(t.partition.column)) errors.push(`파티션에 없는 컬럼 ${t.partition.column}`);
  for (const c of t.columns) for (const d of dupes((c.codes ?? []).map((x) => x.code))) errors.push(`${c.name}: 코드 값 중복 ${d}`);
  return errors;
}

/** YYYY-MM-DD가 달력에 있는 날인지 (2024-13-01·2024-02-30은 아님) */
const realDay = (v: string) => {
  const [y, m, d] = v.slice(0, 10).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};
/** 기본값 글자 null (대소문자 무관) = SQL NULL */
export const isNullText = (v: string) => /^null$/i.test(v);
/** 기본값·코드 값 글자가 컬럼 타입에 맞는지. 시각·날짜는 CURRENT_TIMESTAMP·CURRENT_DATE 또는 날짜 글자 */
export function fitsType(type: Column['type'], v: string): boolean {
  switch (type) {
    case 'int': case 'bigint': return /^[+-]?\d+$/.test(v);
    case 'float': case 'numeric': return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v);
    case 'bool': return /^(true|false|1|0)$/i.test(v);
    // 시간대는 시각 뒤에만 (SQLite julianday·MySQL은 날짜 바로 뒤 시간대를 못 읽음)
    case 'timestamp': return /^current_timestamp$/i.test(v) || (/^\d{4}-\d{2}-\d{2}([ T]([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)?)?$/.test(v) && realDay(v));
    case 'date': return /^current_date$/i.test(v) || (/^\d{4}-\d{2}-\d{2}$/.test(v) && realDay(v));
    case 'uuid': return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
    case 'json': try { JSON.parse(v); return true; } catch { return false; }
    default: return true;
  }
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

/** 노드 주 항목의 저장 방식 */
export const nodeStorageProfile = (n: { primary?: string }, byId: Map<string, CatalogItem>): StorageProfile | undefined =>
  storageProfileOf(n.primary ? byId.get(n.primary) : undefined, byId);

/** 실제로 켜진 기능: 테이블 선택 → 노드 선택 → 권장 기능 순 */
export function selectedFeatures(sp: StorageProfile, node: { storage_features?: string[] }, table?: { storage_features?: string[] }): StorageFeature[] {
  const ids = table?.storage_features ?? node.storage_features;
  return ids ? sp.features.filter((f) => ids.includes(f.id)) : sp.features.filter((f) => f.recommended);
}

/** 주 항목 바꾸기. 저장 기능 선택은 이전 시스템 것이라 지워서 새 시스템의 권장 기능으로 돌아가게 한다 */
/** 사용자가 들어오는 노드(화면 계층). 부하·지연·가용성·API 계산이 모두 여기서 시작한다 */
export const entryNodes = (p: Project) => p.nodes.filter((n) => n.layer === 'ui');
/** 노드가 놓인 리전: 노드에 없으면 프로젝트 기본 리전. 'local' = 사용자 기기 (비용·법령이 같은 규칙) */
export const nodeRegion = (n: ProjectNode, p: Project) => n.region ?? p.cost.region;

/** 노드에 붙은 카탈로그 항목 id: 주 항목, 그다음 보조 항목 */
export const itemIds = (n: { primary?: string; extras: string[] }): string[] => (n.primary ? [n.primary, ...n.extras] : n.extras);

export const withPrimary = (n: ProjectNode, primary: string | undefined): ProjectNode =>
  n.primary === primary ? n : { ...n, primary, storage_features: undefined, tables: n.tables.map((t) => ({ ...t, storage_features: undefined })) };
