// 서비스 내부 인터페이스 명세: 연결선마다 주고받는 REST·gRPC 호출, 큐 메시지, 파일·전문.
// 계산: 보내는 노드가 받는 요청 1건당 호출 수(per_request)로 연결선 부하를 나누고, 요청·응답 크기로 리전 간 전송량을 센다.
// 내보내기: REST → OpenAPI 3.0 (받는 노드마다), gRPC → .proto (받는 노드마다), 메시지 → AsyncAPI 3.0 (토픽마다 보내는·받는 노드),
// 파일·전문 → 레이아웃 CSV, 받는 노드가 FastAPI면 엔드포인트 뼈대(.py).
// shortcut: 크기는 필드 형식별 예시 크기로 어림한다(JSON은 키 이름 포함, protobuf는 태그 1바이트). 실측 크기가 있으면 request_bytes·response_bytes에 넣는다
import { FIELD_TYPES, type Interface, type Project, type ProjectEdge, type SpecField } from './schema';

type FieldType = (typeof FIELD_TYPES)[number];
/** 값 하나의 예시 크기(바이트): JSON 글자 수(따옴표 포함)와 protobuf 이진 크기 */
const JSON_BYTES: Record<FieldType, number> = { string: 34, integer: 8, number: 10, boolean: 5, datetime: 22, uuid: 38, object: 64, array: 64 };
const PROTO_BYTES: Record<FieldType, number> = { string: 33, integer: 4, number: 8, boolean: 1, datetime: 8, uuid: 17, object: 64, array: 64 };

/** 한쪽(요청 또는 응답)의 크기: JSON은 { } + Σ ("키": 값,), protobuf는 Σ (태그 + 값) */
export function bodyBytes(fields: SpecField[], kind: Interface['kind']): number {
  if (!fields.length) return 0;
  return kind === 'grpc'
    ? fields.reduce((s, f) => s + 1 + (f.avg_bytes ?? PROTO_BYTES[f.type]), 0)
    : 2 + fields.reduce((s, f) => s + f.name.length + 4 + (f.avg_bytes ?? JSON_BYTES[f.type]), 0);
}
/** 파일·전문 한 줄(레코드)의 바이트: 고정장 = Σ 필드 길이, 가변장 = Σ 값 + 구분자, 끝에 줄바꿈 */
const PLAIN_BYTES: Record<FieldType, number> = { string: 32, integer: 8, number: 12, boolean: 1, datetime: 14, uuid: 36, object: 64, array: 64 };
const NEWLINE = { crlf: 2, lf: 1, none: 0 } as const;
export function recordBytes(i: Interface): number | undefined {
  const r = i.record;
  if (!r || !i.request.length) return undefined;
  const nl = NEWLINE[r.newline];
  if (r.format === 'fixed') return i.request.every((f) => f.length) ? i.request.reduce((s, f) => s + f.length!, 0) + nl : undefined;
  return i.request.reduce((s, f) => s + (f.avg_bytes ?? PLAIN_BYTES[f.type]), 0) + (i.request.length - 1) * r.delimiter.length + nl;
}
/** 한쪽으로만 보내는 방식(응답·인증·에러 없음): 메시지, 파일·전문 */
export const oneWay = (i: Pick<Interface, 'kind'>) => i.kind === 'message' || i.kind === 'file';

/** 레코드 길이를 모를 때(고정장 길이 일부 없음, 장 형식 미정)의 어림: 필드마다 길이 → 평균 바이트 → 형식별 예시값.
 *  고정장은 평균 바이트를 쓰지 않는다 (가변장에서 바꾸면 화면에 안 보이는 평균 바이트가 남아 있음) */
const roughRecordBytes = (i: Interface) =>
  i.request.length ? i.request.reduce((s, f) => s + (f.length ?? (i.record?.format === 'fixed' ? undefined : f.avg_bytes) ?? PLAIN_BYTES[f.type]), 0) + NEWLINE[i.record?.newline ?? 'crlf'] : 0;
export const requestBytes = (i: Interface) => i.request_bytes ?? (i.kind === 'file' ? recordBytes(i) ?? roughRecordBytes(i) : bodyBytes(i.request, i.kind));
export const responseBytes = (i: Interface) => i.response_bytes ?? bodyBytes(i.response, i.kind);

export const isWrite = (i: Interface) => (i.op ? i.op === 'write' : i.kind === 'rest' ? i.method !== 'GET' : oneWay(i));

/** 연결선의 호출 비율 표시: 명세가 있으면 Σ 호출 수, 없으면 callRatio */
export const edgeCalls = (e: ProjectEdge) => (e.interfaces.length ? e.interfaces.reduce((s, i) => s + i.per_request, 0) : e.callRatio);

type Load = { rps: { normal: number; event: number }; writeRps: { normal: number; event: number } };
/** 인터페이스마다 초당 호출: 보내는 노드의 (전체·읽기·쓰기) 요청 × 호출 수. 읽기 호출은 miss(캐시를 지나 도착하는 몫)를 곱한다 */
export function interfaceRates(e: ProjectEdge, from: Load, s: 'normal' | 'event', miss = 1): { i: Interface; rps: number; write: boolean }[] {
  const w = from.writeRps[s], r = from.rps[s] - w;
  return e.interfaces.map((i) => {
    const base = i.on === 'read' ? r : i.on === 'write' ? w : r + w, write = isWrite(i);
    return { i, rps: base * i.per_request * (write ? 1 : miss), write };
  });
}

export const safe = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(?=\d)/, 'N');

// ---------- OpenAPI ----------
type Json = Record<string, unknown>;
const OAS_TYPE: Record<FieldType, Json> = {
  string: { type: 'string' }, integer: { type: 'integer', format: 'int64' }, number: { type: 'number' }, boolean: { type: 'boolean' },
  datetime: { type: 'string', format: 'date-time' }, uuid: { type: 'string', format: 'uuid' }, object: { type: 'object' }, array: { type: 'array', items: {} },
};
const fieldSchema = (f: SpecField): Json => ({ ...OAS_TYPE[f.type], ...(f.description && { description: f.description }) });
const objectSchema = (fs: SpecField[]): Json => ({
  type: 'object',
  ...(fs.some((f) => f.required) && { required: fs.filter((f) => f.required).map((f) => f.name) }),
  properties: Object.fromEntries(fs.map((f) => [f.name, fieldSchema(f)])),
});

/** 받는 노드마다 REST 작업: 같은 경로·메서드를 여러 노드가 부르면 하나로 두고 부르는 노드만 모은다.
 *  경로의 {변수}는 path, GET의 나머지 요청 필드는 query, 그 밖의 메서드는 본문(JSON) */
export type RestOp = { i: Interface; method: string; opId: string; callers: string[]; inPath: SpecField[]; query: SpecField[]; body: SpecField[] };
export function restOps(p: Project): Map<string, RestOp[]> {
  const nameOf = (id: string) => p.nodes.find((n) => n.id === id)?.name ?? id;
  const out = new Map<string, RestOp[]>();
  for (const e of p.edges) for (const i of e.interfaces.filter((x) => x.kind === 'rest')) {
    const list = out.get(e.to) ?? [];
    const method = (i.method ?? 'GET').toLowerCase();
    const same = list.find((o) => o.i.path === i.path && o.method === method);
    if (same) { same.callers.push(nameOf(e.from)); continue; }
    // 경로 변수인데 요청 필드에 없으면 문자열로 본다
    const inPath = [...i.path.matchAll(/\{(\w+)\}/g)].map((x) => i.request.find((f) => f.name === x[1]) ?? { name: x[1], type: 'string' as const, required: true });
    const rest = i.request.filter((f) => !inPath.some((x) => x.name === f.name));
    list.push({
      i, method, callers: [nameOf(e.from)], inPath,
      opId: `${method}_${safe(i.path)}`.replace(/_+/g, '_').replace(/_$/, ''),
      query: method === 'get' ? rest : [], body: method === 'get' ? [] : rest,
    });
    out.set(e.to, list);
  }
  return out;
}

/** 에러 응답 본문: RFC 9457 problem details에 앱 에러 코드(code)를 더한 형식. 모든 에러가 같은 모양이라 프론트가 한 곳에서 처리한다 */
const PROBLEM: Json = {
  type: 'object', required: ['title', 'status'],
  description: '에러 응답 (RFC 9457 problem details)',
  properties: {
    type: { type: 'string', description: '에러 종류 URI', default: 'about:blank' }, title: { type: 'string', description: '사람이 읽는 짧은 설명' },
    status: { type: 'integer', description: 'HTTP 상태 코드' }, detail: { type: 'string', description: '이번 요청에 대한 자세한 설명' },
    code: { type: 'string', description: '앱이 정한 에러 코드 (예: SALES_DUPLICATE)' },
  },
};
const PROBLEM_CONTENT = { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } };
const VALIDATION_422 = 'VALIDATION_ERROR: 요청 값이 명세와 다름 (FastAPI 요청 검증)';
const SECURITY: Record<'bearer' | 'api_key', Json> = {
  bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Authorization: Bearer <토큰>' },
  api_key: { type: 'apiKey', in: 'header', name: 'X-API-Key', description: '서비스 간 호출용 키' },
};

/** 받는 노드마다 REST 인터페이스를 모은 OpenAPI 3.0 문서: 요청·응답 모델, 인증, 에러 응답(problem+json) */
export function openApiDocs(p: Project): { nodeId: string; doc: Json }[] {
  const nameOf = (id: string) => p.nodes.find((n) => n.id === id)?.name ?? id;
  return [...restOps(p)].map(([nodeId, ops]) => {
    const paths: Record<string, Record<string, Json>> = {};
    const used = new Set(ops.map((o) => o.i.auth).filter((a): a is 'bearer' | 'api_key' => a === 'bearer' || a === 'api_key'));
    // FastAPI는 경로 변수·질의·본문이 있는 작업에 요청 검증 실패(422)를 스스로 붙인다. 뼈대가 이것도 problem+json으로 돌려주므로 명세에도 적는다
    const fastapi = p.nodes.find((n) => n.id === nodeId)?.primary === 'fastapi';
    for (const o of ops) {
      const { i } = o;
      (paths[i.path] ??= {})[o.method] = {
        operationId: o.opId,
        summary: i.name,
        ...(i.description && { description: i.description }),
        'x-callers': o.callers,
        ...(o.inPath.length + o.query.length > 0 && {
          parameters: [
            ...o.inPath.map((f) => ({ name: f.name, in: 'path', required: true, schema: OAS_TYPE[f.type], ...(f.description && { description: f.description }) })),
            ...o.query.map((f) => ({ name: f.name, in: 'query', required: f.required, schema: OAS_TYPE[f.type], ...(f.description && { description: f.description }) })),
          ],
        }),
        ...(o.body.length > 0 && { requestBody: { required: true, content: { 'application/json': { schema: objectSchema(o.body) } } } }),
        // 인증이 정해진 작업만 security를 적는다 (none은 빈 배열 = 인증 없음)
        ...(i.auth && { security: i.auth === 'none' ? [] : [{ [i.auth]: [] }] }),
        responses: {
          // 응답 필드가 없으면 본문 없는 204
          ...(i.response.length > 0 ? { 200: { description: 'OK', content: { 'application/json': { schema: objectSchema(i.response) } } } } : { 204: { description: 'No Content' } }),
          ...(fastapi && o.inPath.length + o.query.length + o.body.length > 0 && { 422: { description: VALIDATION_422, content: PROBLEM_CONTENT } }),
          ...Object.fromEntries(groupErrors(i).map(([status, list]) => [status, {
            description: list.map((x) => `${x.code ? `${x.code}: ` : ''}${x.description}`).join(' / '),
            content: PROBLEM_CONTENT,
          }])),
        },
      };
    }
    return {
      nodeId,
      doc: {
        openapi: '3.0.3', info: { title: `${nameOf(nodeId)} API`, version: '1.0.0', description: `${p.name} — App Architect Studio에서 만든 내부 인터페이스 명세` }, paths,
        components: { schemas: { Problem: PROBLEM }, ...(used.size > 0 && { securitySchemes: Object.fromEntries([...used].map((a) => [a, SECURITY[a]])) }) },
      },
    };
  });
}
/** 같은 상태 코드의 에러를 묶는다 (OpenAPI 응답은 상태 코드마다 하나) */
const groupErrors = (i: Interface) => [...new Set(i.errors.map((x) => x.status))].sort().map((st) => [String(st), i.errors.filter((x) => x.status === st)] as const);

// ---------- AsyncAPI ----------
/** 큐 메시지를 토픽마다 모은 AsyncAPI 3.0 문서. 보내는 노드 = 메시지 인터페이스가 있는 연결선의 출발, 받는 노드 = 그 큐에서 나가는 연결선의 도착 */
export function asyncApiDoc(p: Project): Json | undefined {
  const nameOf = (id: string) => p.nodes.find((n) => n.id === id)?.name ?? id;
  const msgs = p.edges.flatMap((e) => e.interfaces.filter((i) => i.kind === 'message').map((i) => ({ e, i })));
  if (!msgs.length) return undefined;
  const channels: Json = {}, operations: Json = {};
  for (const { e, i } of msgs) {
    const ch = safe(i.path), msg = `${ch}_message`;
    channels[ch] ??= {
      address: i.path,
      ...(i.description && { description: i.description }),
      messages: { [msg]: { name: i.name, contentType: 'application/json', payload: objectSchema(i.request) } },
    };
    const ref = { $ref: `#/channels/${ch}` };
    operations[`${safe(e.from)}_send_${ch}`] = { action: 'send', channel: ref, summary: `${nameOf(e.from)} → ${i.name}`, 'x-node': nameOf(e.from) };
    for (const c of p.edges.filter((x) => x.from === e.to)) {
      operations[`${safe(c.to)}_receive_${ch}`] = { action: 'receive', channel: ref, summary: `${nameOf(c.to)} ← ${i.name}`, 'x-node': nameOf(c.to) };
    }
  }
  return { asyncapi: '3.0.0', info: { title: `${p.name} 메시지`, version: '1.0.0', description: 'App Architect Studio에서 만든 내부 메시지 명세' }, channels, operations };
}

// ---------- proto ----------
const PROTO_TYPE: Record<FieldType, string> = {
  string: 'string', integer: 'int64', number: 'double', boolean: 'bool', datetime: 'google.protobuf.Timestamp', uuid: 'string', object: 'google.protobuf.Struct', array: 'repeated google.protobuf.Value',
};
const protoMessage = (name: string, fs: SpecField[]) => [
  `message ${name} {`,
  ...fs.map((f, k) => {
    const t = PROTO_TYPE[f.type], opt = !f.required && !t.startsWith('repeated') && !t.startsWith('google') ? 'optional ' : '';
    return `  ${opt}${t} ${f.name} = ${k + 1};${f.description ? ` // ${f.description.replace(/\n/g, ' ')}` : ''}`;
  }),
  '}',
];

/** 받는 노드마다 gRPC 인터페이스를 모은 .proto */
export function protoFiles(p: Project): { nodeId: string; text: string }[] {
  const nameOf = (id: string) => p.nodes.find((n) => n.id === id)?.name ?? id;
  const byTarget = new Map<string, Interface[]>();
  for (const e of p.edges) for (const i of e.interfaces.filter((x) => x.kind === 'grpc')) {
    const list = byTarget.get(e.to) ?? [];
    if (!list.some((x) => x.path === i.path)) byTarget.set(e.to, [...list, i]);
  }
  return [...byTarget].map(([nodeId, list]) => {
    const used = list.flatMap((i) => [...i.request, ...i.response]).map((f) => f.type);
    const svc = `${safe(nodeId)}Service`;
    const text = [
      'syntax = "proto3";', '', `// ${nameOf(nodeId)} — ${p.name} (App Architect Studio에서 만든 내부 인터페이스 명세)`, `package aas.${safe(nodeId).toLowerCase()};`, '',
      ...(used.includes('datetime') ? ['import "google/protobuf/timestamp.proto";'] : []),
      ...(used.includes('object') || used.includes('array') ? ['import "google/protobuf/struct.proto";'] : []),
      '', `service ${svc} {`,
      ...list.flatMap((i) => [`  // ${i.name}${i.description ? `: ${i.description.replace(/\n/g, ' ')}` : ''}`, `  rpc ${i.path} (${i.path}Request) returns (${i.path}Response);`]),
      '}', '',
      ...list.flatMap((i) => [...protoMessage(`${i.path}Request`, i.request), '', ...protoMessage(`${i.path}Response`, i.response), '']),
    ].join('\n');
    return { nodeId, text };
  });
}

// ---------- 명세 점검과 기술별 권장안 ----------
/** 명세에서 빠진 것: 보내는 쪽과 받는 쪽이 각자 다르게 짤 수 있는 곳 */
export function specGaps(i: Interface): string[] {
  const gaps: string[] = [];
  const call = !oneWay(i);
  if (i.kind === 'message' && !i.request.length) gaps.push('메시지 필드가 없음');
  if (i.kind === 'file') {
    if (!i.record) gaps.push('장 형식(고정장·가변장)이 정해지지 않음');
    if (!i.request.length) gaps.push('레코드 필드가 없음');
    const noLen = i.request.filter((f) => !f.length).map((f) => f.name);
    if (i.record?.format === 'fixed' && noLen.length) gaps.push(`고정장 필드 길이가 없음: ${noLen.join(', ')}`);
  }
  if (i.kind === 'rest') {
    const inPath = [...i.path.matchAll(/\{(\w+)\}/g)].map((x) => x[1]);
    for (const v of inPath.filter((v) => !i.request.some((f) => f.name === v))) gaps.push(`경로 변수 {${v}}의 형식이 없음 (문자열로 가정)`);
    if (['POST', 'PUT', 'PATCH'].includes(i.method ?? 'GET') && !i.request.some((f) => !inPath.includes(f.name))) gaps.push('요청 본문 필드가 없음');
  }
  if (i.kind === 'grpc' && !i.request.length) gaps.push('요청 필드가 없음');
  if (call && !i.response.length && !(i.kind === 'rest' && i.method === 'DELETE')) gaps.push('응답 형식이 없음');
  if (call && !i.errors.length) gaps.push('에러 응답이 없음 (실패할 때 무엇을 돌려줄지)');
  if (call && !i.auth) gaps.push('인증 방식이 정해지지 않음');
  return gaps;
}
export const GAP_EFFECT = '이 상태로는 보내는 쪽과 받는 쪽이 각자 다르게 짤 수 있어요.';

/** 받는 노드의 기술에 맞춘 계약 공유 방법. 코드에서 명세를 만들어 주는 프레임워크면 뼈대를 먼저 만들고 자동 문서를 공유한다 */
export function specAdvice(p: Project): { nodeId: string; title: string; text: string; file?: string }[] {
  const out: { nodeId: string; title: string; text: string; file?: string }[] = [];
  const kinds = new Map<string, Set<Interface['kind']>>();
  for (const e of p.edges) for (const i of e.interfaces) kinds.set(e.to, (kinds.get(e.to) ?? new Set()).add(i.kind));
  for (const [nodeId, ks] of kinds) {
    const n = p.nodes.find((x) => x.id === nodeId)!;
    if (ks.has('rest')) {
      const file = n.primary === 'fastapi' ? fastApiName(nodeId) : undefined;
      out.push({ nodeId, file, ...(REST_ADVICE[n.primary ?? ''] ?? REST_DEFAULT) });
    }
    if (ks.has('grpc')) out.push({ nodeId, title: 'gRPC: .proto가 곧 계약', text: `내보낸 ${safe(nodeId)}.proto를 양쪽이 그대로 쓰고, 각 언어의 protoc 플러그인으로 코드를 만드세요. 필드를 바꿀 때는 번호를 재사용하지 않습니다.` });
    if (ks.has('file')) out.push({ nodeId, title: '파일·전문: 레이아웃 표가 계약', text: '내보낸 layout-….csv(필드 순서·바이트 길이·시작·끝 위치·채움 규칙·인코딩)를 보내는 쪽·받는 쪽이 같이 봅니다. 고정장은 한 바이트만 어긋나도 뒤 필드가 모두 밀리므로, 필드를 더할 때는 맨 뒤에 붙이고 레코드 길이를 같이 알립니다. EUC-KR이면 한글 한 글자가 2바이트, UTF-8이면 3바이트입니다.' });
    if (ks.has('message') && n.layer === 'queue') out.push({ nodeId, title: '메시지: AsyncAPI로 공유', text: '내보낸 asyncapi.json의 채널(토픽)과 메시지 필드를 보내는 쪽·받는 쪽이 같이 봅니다. 필드를 지우거나 뜻을 바꾸지 말고 새 필드를 더하세요(받는 쪽이 옛 메시지도 읽을 수 있게).' });
  }
  return out;
}
const REST_DEFAULT = {
  title: 'REST: 명세 먼저 합의',
  text: '이 기술은 코드에서 명세를 만드는 방식이 기본이 아니므로, 내보낸 OpenAPI 파일을 먼저 합의하고 양쪽이 그 파일에서 코드를 만드는(예: openapi-generator) 방식이 안전합니다.',
};
const REST_ADVICE: Record<string, { title: string; text: string }> = {
  fastapi: {
    title: 'FastAPI: 뼈대와 모델을 먼저, 자동 문서를 공유',
    text: 'FastAPI는 코드에 요청과 응답 모델(pydantic)을 정의하면 OpenAPI 명세서(/docs)를 자동으로 만들어 줍니다. 그래서 별도 문서를 길게 쓰기보다, 백엔드에서 엔드포인트 뼈대와 모델만 먼저 만들고 그 자동 문서를 프론트와 공유하는 방식이 가장 가볍습니다. 인터페이스 명세 내보내기에 그 뼈대 파일이 들어 있습니다.',
  },
  spring_boot: {
    title: 'Spring Boot: 컨트롤러·DTO 뼈대를 먼저, 자동 문서를 공유',
    text: 'springdoc-openapi를 넣으면 컨트롤러와 DTO에서 OpenAPI(/v3/api-docs)와 Swagger UI를 자동으로 만들어 줍니다. 내보낸 OpenAPI를 기준으로 컨트롤러·DTO 뼈대를 먼저 만들고, 그 자동 문서를 프론트와 공유하세요. 기본 에러 본문은 Spring 형식이라, 명세처럼 problem+json으로 맞추려면 spring.mvc.problemdetails.enabled=true를 켭니다.',
  },
  node_fastify: {
    title: 'Fastify·NestJS: 스키마·데코레이터에서 자동 문서',
    text: 'Fastify는 @fastify/swagger가 라우트의 JSON 스키마로, NestJS는 @nestjs/swagger가 DTO 데코레이터로 OpenAPI를 만들어 줍니다. 라우트·DTO 뼈대를 먼저 만들고 그 자동 문서를 프론트와 공유하세요. 검증 실패는 기본 400(Fastify 형식)이라 setErrorHandler(Fastify)·예외 필터(NestJS)로 problem+json을 맞추고, NestJS의 POST는 기본 201이라 명세가 200이면 @HttpCode(200)을 붙입니다.',
  },
};

// ---------- FastAPI 뼈대 ----------
const fastApiName = (nodeId: string) => `${safe(nodeId)}_fastapi.py`;
const PY_TYPE: Record<FieldType, string> = { string: 'str', integer: 'int', number: 'float', boolean: 'bool', datetime: 'datetime', uuid: 'UUID', object: 'dict[str, Any]', array: 'list[Any]' };
const PY_KEYWORDS = new Set(['False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield']);
/** 파이썬 문자열 (JSON 문자열 표기는 파이썬에서도 같은 뜻) */
const py = (s: string) => JSON.stringify(s);
const pyName = (n: string) => (PY_KEYWORDS.has(n) ? `${n}_` : n);
const pascal = (s: string) => s.split('_').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('');

function pyModel(name: string, fs: SpecField[]): string[] {
  if (!fs.length) return [];
  return [
    `class ${name}(BaseModel):`,
    ...(fs.some((f) => PY_KEYWORDS.has(f.name)) ? ['    model_config = ConfigDict(populate_by_name=True)'] : []),
    ...fs.map((f) => {
      const t = PY_TYPE[f.type], args = [f.required ? '...' : 'None', ...(PY_KEYWORDS.has(f.name) ? [`alias=${py(f.name)}`] : []), ...(f.description ? [`description=${py(f.description)}`] : [])];
      return `    ${pyName(f.name)}: ${f.required ? t : `Optional[${t}]`} = Field(${args.join(', ')})`;
    }),
    '', '',
  ];
}

/** 받는 노드가 FastAPI면: pydantic 요청·응답 모델과 엔드포인트 뼈대(각 함수는 501). 실행하면 /docs가 이 명세와 같은 OpenAPI를 보여 준다 */
export function fastApiFiles(p: Project): { nodeId: string; name: string; text: string }[] {
  const nameOf = (id: string) => p.nodes.find((n) => n.id === id)?.name ?? id;
  return [...restOps(p)].filter(([id]) => p.nodes.find((n) => n.id === id)?.primary === 'fastapi').map(([nodeId, ops]) => {
    const auth = new Set(ops.map((o) => o.i.auth));
    const models = ops.flatMap((o) => [...pyModel(`${pascal(o.opId)}Request`, o.body), ...pyModel(`${pascal(o.opId)}Response`, o.i.response)]);
    const routes = ops.flatMap((o) => {
      const { i } = o, P = pascal(o.opId);
      const params = [
        ...o.inPath.map((f) => `${pyName(f.name)}: ${PY_TYPE[f.type]}`),
        ...o.query.map((f) => {
          // 객체·배열은 질의 문자열로 못 받아 JSON 문자열로 받는다
          const t = f.type === 'object' || f.type === 'array' ? 'str' : PY_TYPE[f.type];
          const args = [f.required ? '...' : 'None', ...(PY_KEYWORDS.has(f.name) ? [`alias=${py(f.name)}`] : []), ...(f.description ? [`description=${py(f.description)}`] : [])];
          return `${pyName(f.name)}: ${f.required ? t : `Optional[${t}]`} = Query(${args.join(', ')})`;
        }),
        ...(o.body.length ? [`body: ${P}Request`] : []),
        ...(i.auth === 'bearer' ? ['_token: HTTPAuthorizationCredentials = Depends(require_bearer)'] : i.auth === 'api_key' ? ['_key: str = Depends(require_api_key)'] : []),
      ];
      const ret = i.response.length ? `${P}Response` : 'None';
      const errs = groupErrors(i);
      const deco = [
        py(i.path), ...(i.response.length ? [`response_model=${P}Response`] : ['status_code=204', 'response_class=Response']), `summary=${py(i.name)}`,
        ...(i.description ? [`description=${py(i.description)}`] : []),
        ...(errs.length ? [`responses={${errs.map(([st, list]) => `${st}: {"description": ${py(list.map((x) => `${x.code ? `${x.code}: ` : ''}${x.description}`).join(' / '))}, "content": PROBLEM_JSON}`).join(', ')}}`] : []),
      ];
      return [
        `@app.${o.method}(${deco.join(', ')})`,
        `def ${o.opId}(${params.join(', ')}) -> ${ret}:`,
        `    """부르는 노드: ${o.callers.join(', ').replace(/"/g, "'")}"""`,
        ...i.errors.map((x) => `    # ${x.status}${x.code ? ` ${x.code}` : ''}: ${x.description.replace(/\n/g, ' ')} → raise ApiError(${x.status}, ${py(x.description)}${x.code ? `, ${py(x.code)}` : ''})`),
        ...(i.auth === undefined ? ['    # TODO: 인증 방식이 정해지지 않았습니다 (명세 점검)'] : []),
        '    raise ApiError(501, "구현 필요", "NOT_IMPLEMENTED")',
        '', '',
      ];
    });
    const text = [
      `# ${nameOf(nodeId)} — FastAPI 엔드포인트 뼈대 (${p.name})`,
      '# App Architect Studio의 인터페이스 명세에서 만들었습니다. 모델과 엔드포인트만 있고, 각 함수는 501(구현 필요)을 돌려줍니다.',
      `# 실행: pip install "fastapi[standard]"  →  fastapi dev ${fastApiName(nodeId)}  →  http://127.0.0.1:8000/docs 를 프론트와 공유`,
      '# 에러는 모두 problem+json(Problem)입니다: 앱 에러는 ApiError로 내고, 요청 검증 실패(422)·인증 실패(401)·그 밖의 HTTP 에러도 같은 형식으로 바꿉니다.',
      'from datetime import datetime',
      'from typing import Any, Optional',
      'from uuid import UUID',
      '',
      `from fastapi import Depends, FastAPI, Query, Request${ops.some((o) => !o.i.response.length) ? ', Response' : ''}`,
      'from fastapi.exceptions import RequestValidationError',
      'from fastapi.openapi.utils import get_openapi',
      'from fastapi.responses import JSONResponse',
      ...(auth.has('bearer') || auth.has('api_key')
        ? [`from fastapi.security import ${[...(auth.has('api_key') ? ['APIKeyHeader'] : []), ...(auth.has('bearer') ? ['HTTPAuthorizationCredentials', 'HTTPBearer'] : [])].join(', ')}`] : []),
      `from pydantic import BaseModel, ${ops.some((o) => [...o.body, ...o.i.response].some((f) => PY_KEYWORDS.has(f.name))) ? 'ConfigDict, ' : ''}Field`,
      '',
      'from starlette.exceptions import HTTPException as StarletteHTTPException',
      '',
      `app = FastAPI(title=${py(nameOf(nodeId))}, version="1.0.0")`,
      'PROBLEM_JSON = {"application/problem+json": {"schema": {"$ref": "#/components/schemas/Problem"}}}',
      '', '',
      'class Problem(BaseModel):',
      '    """에러 응답 (RFC 9457 problem details + 앱 에러 코드)"""',
      '    type: str = "about:blank"',
      '    title: str',
      '    status: int',
      '    detail: Optional[str] = None',
      '    code: Optional[str] = None',
      '', '',
      'class ApiError(Exception):',
      '    def __init__(self, status: int, title: str, code: Optional[str] = None, detail: Optional[str] = None):',
      '        self.problem = Problem(title=title, status=status, code=code, detail=detail)',
      '', '',
      'def problem_response(problem: Problem) -> JSONResponse:',
      '    return JSONResponse(status_code=problem.status, content=problem.model_dump(exclude_none=True), media_type="application/problem+json")',
      '', '',
      '@app.exception_handler(ApiError)',
      'async def api_error(_request: Request, e: ApiError) -> JSONResponse:',
      '    return problem_response(e.problem)',
      '', '',
      '@app.exception_handler(RequestValidationError)',
      'async def validation_error(_request: Request, e: RequestValidationError) -> JSONResponse:',
      `    detail = "; ".join(f"{'.'.join(map(str, x['loc']))}: {x['msg']}" for x in e.errors())`,
      '    return problem_response(Problem(title="요청 값이 명세와 다릅니다", status=422, code="VALIDATION_ERROR", detail=detail))',
      '', '',
      '@app.exception_handler(StarletteHTTPException)',
      'async def http_error(_request: Request, e: StarletteHTTPException) -> JSONResponse:',
      '    return problem_response(Problem(title=str(e.detail), status=e.status_code))',
      '', '',
      ...(auth.has('bearer') ? [
        '_bearer = HTTPBearer(auto_error=False)  # Authorization: Bearer <토큰>',
        '', '',
        'def require_bearer(cred: Optional[HTTPAuthorizationCredentials] = Depends(_bearer)) -> HTTPAuthorizationCredentials:',
        '    if cred is None:',
        '        raise ApiError(401, "인증이 필요합니다", "UNAUTHORIZED")',
        '    return cred  # TODO: 토큰 검증',
        '', '',
      ] : []),
      ...(auth.has('api_key') ? [
        '_api_key = APIKeyHeader(name="X-API-Key", auto_error=False)  # 서비스 간 호출용 키',
        '', '',
        'def require_api_key(key: Optional[str] = Depends(_api_key)) -> str:',
        '    if key is None:',
        '        raise ApiError(401, "API 키가 필요합니다", "UNAUTHORIZED")',
        '    return key  # TODO: 키 검증',
        '', '',
      ] : []),
      ...models,
      ...routes,
      'def custom_openapi() -> dict[str, Any]:',
      '    \"\"\"/docs 명세: 에러 응답은 모두 problem+json(Problem). FastAPI가 붙이는 요청 검증(422)도 같은 형식으로 적는다\"\"\"',
      '    if app.openapi_schema:',
      '        return app.openapi_schema',
      '    schema = get_openapi(title=app.title, version=app.version, routes=app.routes)',
      '    schemas = schema.setdefault("components", {}).setdefault("schemas", {})',
      '    schemas["Problem"] = Problem.model_json_schema()',
      '    for name in ("HTTPValidationError", "ValidationError"):',
      '        schemas.pop(name, None)',
      '    for item in schema.get("paths", {}).values():',
      '        for op in item.values():',
      '            r = op.get("responses", {}).get("422")',
      '            if r is not None:',
      `                op["responses"]["422"] = {"description": ${py(VALIDATION_422)} if r.get("description") == "Validation Error" else r["description"], "content": PROBLEM_JSON}`,
      '    app.openapi_schema = schema',
      '    return schema',
      '', '',
      'app.openapi = custom_openapi',
    ].join('\n') + '\n';
    return { nodeId, name: fastApiName(nodeId), text };
  });
}

// ---------- 파일·전문 레이아웃 ----------
/** 고정장: 숫자는 오른쪽 맞춤·앞을 0으로, 그 밖은 왼쪽 맞춤·뒤를 공백으로 채운다 */
const numeric = (f: SpecField) => f.type === 'integer' || f.type === 'number';
export type LayoutRow = { no: number; field: SpecField; start?: number; end?: number; align?: '왼쪽' | '오른쪽'; pad?: string };
export function layoutRows(i: Interface): LayoutRow[] {
  // 길이 없는 필드가 나오면 그 뒤 필드의 위치는 모른다
  let at: number | undefined = 1;
  return i.request.map((field, k) => {
    if (!field.length) at = undefined;
    if (i.record?.format !== 'fixed' || at === undefined) return { no: k + 1, field };
    const row: LayoutRow = { no: k + 1, field, start: at, end: at + field.length! - 1, align: numeric(field) ? '오른쪽' : '왼쪽', pad: numeric(field) ? '0' : '공백' };
    at += field.length!;
    return row;
  });
}
export const csvCell = (v: unknown) => {
  let s = v === undefined ? '' : String(v);
  // 엑셀이 = + - @로 시작하는 칸을 수식으로 읽지 않게 (진짜 숫자 -1 같은 것은 그대로), 탭·CR로 시작하는 칸도
  if ((/^[=+\-@]/.test(s) && !Number.isFinite(Number(s))) || /^[\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/** 레이아웃 표(CSV, 엑셀에서 한글이 깨지지 않게 BOM). 첫 줄들은 장 형식·인코딩·레코드 길이 */
export function layoutCsv(i: Interface, from: string, to: string): string {
  const r = i.record;
  const head = [
    ['인터페이스', i.name], ['보내는 → 받는', `${from} → ${to}`], ['파일·전문 ID', i.path],
    ['장 형식', !r ? '미정' : r.format === 'fixed' ? '고정장' : `가변장 (구분자 ${JSON.stringify(r.delimiter)}${r.header ? ', 머리줄 있음' : ''})`],
    ['인코딩', r?.encoding ?? '미정'], ['줄바꿈', r ? { crlf: 'CRLF', lf: 'LF', none: '없음' }[r.newline] : '미정'],
    ['레코드 길이(바이트)', recordBytes(i) ?? ''],
  ];
  const fixed = r?.format === 'fixed';
  const cols = fixed ? ['순번', '필드', '설명', '형식', '필수', '길이', '시작', '끝', '맞춤', '채움'] : ['순번', '필드', '설명', '형식', '필수', '평균 바이트'];
  const rows = layoutRows(i).map((x) => (fixed
    ? [x.no, x.field.name, x.field.description, x.field.type, x.field.required ? 'Y' : 'N', x.field.length, x.start, x.end, x.align, x.pad]
    : [x.no, x.field.name, x.field.description, x.field.type, x.field.required ? 'Y' : 'N', x.field.avg_bytes]));
  return '\uFEFF' + [...head, [], cols, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** 내보낼 파일 전부: openapi-노드.json, 노드.proto, asyncapi.json, (받는 노드가 FastAPI면) 노드_fastapi.py, 파일·전문마다 layout-보내는-받는-ID.csv */
export function interfaceFiles(p: Project): { name: string; text: string }[] {
  const a = asyncApiDoc(p);
  return uniqueNames([
    ...openApiDocs(p).map(({ nodeId, doc }) => ({ name: `openapi-${safe(nodeId)}.json`, text: JSON.stringify(doc, null, 2) })),
    ...protoFiles(p).map(({ nodeId, text }) => ({ name: `${safe(nodeId)}.proto`, text })),
    ...(a ? [{ name: 'asyncapi.json', text: JSON.stringify(a, null, 2) }] : []),
    ...fastApiFiles(p).map(({ name, text }) => ({ name, text })),
    ...p.edges.flatMap((e) => e.interfaces.filter((i) => i.kind === 'file').map((i) => ({
      name: `layout-${safe(e.from)}-${safe(e.to)}-${safe(i.path)}.csv`,
      text: layoutCsv(i, p.nodes.find((n) => n.id === e.from)?.name ?? e.from, p.nodes.find((n) => n.id === e.to)?.name ?? e.to),
    }))),
  ]);
}

/** 이름이 겹치면 확장자 앞에 -2, -3을 붙인다 (safe()로 바꾼 이름이 같아지거나 대소문자만 달라 Windows에서 덮어쓰는 것을 막음) */
export function uniqueNames<T extends { name: string }>(files: T[]): T[] {
  const used = new Set<string>();
  return files.map((f) => {
    let name = f.name;
    for (let k = 2; used.has(name.toLowerCase()); k++) name = f.name.replace(/(\.[^.]*)?$/, `-${k}$1`);
    used.add(name.toLowerCase());
    return name === f.name ? f : { ...f, name };
  });
}

