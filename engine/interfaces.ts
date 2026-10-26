// 서비스 내부 인터페이스 명세: 연결선마다 주고받는 REST·gRPC 호출과 큐 메시지.
// 계산: 보내는 노드가 받는 요청 1건당 호출 수(per_request)로 연결선 부하를 나누고, 요청·응답 크기로 리전 간 전송량을 센다.
// 내보내기: REST → OpenAPI 3.0 (받는 노드마다), gRPC → .proto (받는 노드마다), 메시지 → AsyncAPI 3.0 (토픽마다 보내는·받는 노드).
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
export const requestBytes = (i: Interface) => i.request_bytes ?? bodyBytes(i.request, i.kind);
export const responseBytes = (i: Interface) => i.response_bytes ?? bodyBytes(i.response, i.kind);

export const isWrite = (i: Interface) => (i.op ? i.op === 'write' : i.kind === 'rest' ? i.method !== 'GET' : i.kind === 'message');

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

const safe = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(?=\d)/, 'N');

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
          200: { description: 'OK', ...(i.response.length > 0 && { content: { 'application/json': { schema: objectSchema(i.response) } } }) },
          ...Object.fromEntries(groupErrors(i).map(([status, list]) => [status, {
            description: list.map((x) => `${x.code ? `${x.code}: ` : ''}${x.description}`).join(' / '),
            content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } },
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
  const call = i.kind !== 'message';
  if (i.kind === 'message' && !i.request.length) gaps.push('메시지 필드가 없음');
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
    text: 'springdoc-openapi를 넣으면 컨트롤러와 DTO에서 OpenAPI(/v3/api-docs)와 Swagger UI를 자동으로 만들어 줍니다. 내보낸 OpenAPI를 기준으로 컨트롤러·DTO 뼈대를 먼저 만들고, 그 자동 문서를 프론트와 공유하세요.',
  },
  node_fastify: {
    title: 'Fastify·NestJS: 스키마·데코레이터에서 자동 문서',
    text: 'Fastify는 @fastify/swagger가 라우트의 JSON 스키마로, NestJS는 @nestjs/swagger가 DTO 데코레이터로 OpenAPI를 만들어 줍니다. 라우트·DTO 뼈대를 먼저 만들고 그 자동 문서를 프론트와 공유하세요.',
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
        ...(i.auth === 'bearer' ? ['_token: HTTPAuthorizationCredentials = Depends(bearer)'] : i.auth === 'api_key' ? ['_key: str = Depends(api_key)'] : []),
      ];
      const ret = i.response.length ? `${P}Response` : 'None';
      const errs = groupErrors(i);
      const deco = [
        py(i.path), ...(i.response.length ? [`response_model=${P}Response`] : []), `summary=${py(i.name)}`,
        ...(i.description ? [`description=${py(i.description)}`] : []),
        ...(errs.length ? [`responses={${errs.map(([st, list]) => `${st}: {"model": Problem, "description": ${py(list.map((x) => `${x.code ? `${x.code}: ` : ''}${x.description}`).join(' / '))}}`).join(', ')}}`] : []),
      ];
      return [
        `@app.${o.method}(${deco.join(', ')})`,
        `def ${o.opId}(${params.join(', ')}) -> ${ret}:`,
        `    """부르는 노드: ${o.callers.join(', ').replace(/"/g, "'")}"""`,
        ...i.errors.map((x) => `    # ${x.status}${x.code ? ` ${x.code}` : ''}: ${x.description.replace(/\n/g, ' ')} → raise ApiError(${x.status}, ${py(x.description)}${x.code ? `, ${py(x.code)}` : ''})`),
        ...(i.auth === undefined ? ['    # TODO: 인증 방식이 정해지지 않았습니다 (명세 점검)'] : []),
        '    raise HTTPException(status_code=501, detail="구현 필요")',
        '', '',
      ];
    });
    const text = [
      `# ${nameOf(nodeId)} — FastAPI 엔드포인트 뼈대 (${p.name})`,
      '# App Architect Studio의 인터페이스 명세에서 만들었습니다. 모델과 엔드포인트만 있고, 각 함수는 501(구현 필요)을 돌려줍니다.',
      `# 실행: pip install "fastapi[standard]"  →  fastapi dev ${fastApiName(nodeId)}  →  http://127.0.0.1:8000/docs 를 프론트와 공유`,
      '# 요청 검증에 실패하면 FastAPI가 422(자체 형식)를 돌려줍니다. 앱 에러는 ApiError로 problem+json 형식을 맞춥니다.',
      'from datetime import datetime',
      'from typing import Any, Optional',
      'from uuid import UUID',
      '',
      'from fastapi import Depends, FastAPI, HTTPException, Query, Request',
      ...(auth.has('bearer') || auth.has('api_key')
        ? [`from fastapi.security import ${[...(auth.has('api_key') ? ['APIKeyHeader'] : []), ...(auth.has('bearer') ? ['HTTPAuthorizationCredentials', 'HTTPBearer'] : [])].join(', ')}`] : []),
      'from fastapi.responses import JSONResponse',
      `from pydantic import BaseModel, ${ops.some((o) => [...o.body, ...o.i.response].some((f) => PY_KEYWORDS.has(f.name))) ? 'ConfigDict, ' : ''}Field`,
      '',
      `app = FastAPI(title=${py(nameOf(nodeId))}, version="1.0.0")`,
      ...(auth.has('bearer') ? ['bearer = HTTPBearer()  # Authorization: Bearer <토큰>'] : []),
      ...(auth.has('api_key') ? ['api_key = APIKeyHeader(name="X-API-Key")  # 서비스 간 호출용 키'] : []),
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
      '@app.exception_handler(ApiError)',
      'async def api_error(_request: Request, e: ApiError) -> JSONResponse:',
      '    return JSONResponse(status_code=e.problem.status, content=e.problem.model_dump(exclude_none=True), media_type="application/problem+json")',
      '', '',
      ...models,
      ...routes,
    ].join('\n').replace(/\n{3,}$/, '\n');
    return { nodeId, name: fastApiName(nodeId), text };
  });
}

/** 내보낼 파일 전부: openapi-노드.json, 노드.proto, asyncapi.json, (받는 노드가 FastAPI면) 노드_fastapi.py */
export function interfaceFiles(p: Project): { name: string; text: string }[] {
  const a = asyncApiDoc(p);
  return [
    ...openApiDocs(p).map(({ nodeId, doc }) => ({ name: `openapi-${safe(nodeId)}.json`, text: JSON.stringify(doc, null, 2) })),
    ...protoFiles(p).map(({ nodeId, text }) => ({ name: `${safe(nodeId)}.proto`, text })),
    ...(a ? [{ name: 'asyncapi.json', text: JSON.stringify(a, null, 2) }] : []),
    ...fastApiFiles(p).map(({ name, text }) => ({ name, text })),
  ];
}

