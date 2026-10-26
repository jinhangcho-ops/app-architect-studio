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

/** 받는 노드마다 REST 인터페이스를 모은 OpenAPI 3.0 문서 */
export function openApiDocs(p: Project): { nodeId: string; doc: Json }[] {
  const nameOf = (id: string) => p.nodes.find((n) => n.id === id)?.name ?? id;
  const byTarget = new Map<string, { e: ProjectEdge; i: Interface }[]>();
  for (const e of p.edges) for (const i of e.interfaces.filter((x) => x.kind === 'rest')) byTarget.set(e.to, [...(byTarget.get(e.to) ?? []), { e, i }]);
  return [...byTarget].map(([nodeId, list]) => {
    const paths: Record<string, Record<string, Json>> = {};
    for (const { e, i } of list) {
      const method = (i.method ?? 'GET').toLowerCase();
      const op = paths[i.path]?.[method];
      // 같은 경로·메서드를 여러 노드가 부르면 하나로 두고 부르는 노드만 더한다
      if (op) { (op['x-callers'] as string[]).push(nameOf(e.from)); continue; }
      const inPath = [...i.path.matchAll(/\{(\w+)\}/g)].map((x) => x[1]);
      const field = (n: string) => i.request.find((f) => f.name === n);
      const rest = i.request.filter((f) => !inPath.includes(f.name));
      const query = method === 'get' ? rest : [];
      const body = method === 'get' ? [] : rest;
      (paths[i.path] ??= {})[method] = {
        operationId: `${method}_${safe(i.path)}`.replace(/_+/g, '_').replace(/_$/, ''),
        summary: i.name,
        ...(i.description && { description: i.description }),
        'x-callers': [nameOf(e.from)],
        ...(inPath.length + query.length > 0 && {
          parameters: [
            ...inPath.map((n) => ({ name: n, in: 'path', required: true, schema: field(n) ? OAS_TYPE[field(n)!.type] : { type: 'string' } })),
            ...query.map((f) => ({ name: f.name, in: 'query', required: f.required, schema: OAS_TYPE[f.type], ...(f.description && { description: f.description }) })),
          ],
        }),
        ...(body.length > 0 && { requestBody: { required: true, content: { 'application/json': { schema: objectSchema(body) } } } }),
        responses: { 200: { description: 'OK', ...(i.response.length > 0 && { content: { 'application/json': { schema: objectSchema(i.response) } } }) } },
      };
    }
    return {
      nodeId,
      doc: { openapi: '3.0.3', info: { title: `${nameOf(nodeId)} API`, version: '1.0.0', description: `${p.name} — App Architect Studio에서 만든 내부 인터페이스 명세` }, paths },
    };
  });
}

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

/** 내보낼 파일 전부: openapi-노드.json, 노드.proto, asyncapi.json */
export function interfaceFiles(p: Project): { name: string; text: string }[] {
  const a = asyncApiDoc(p);
  return [
    ...openApiDocs(p).map(({ nodeId, doc }) => ({ name: `openapi-${safe(nodeId)}.json`, text: JSON.stringify(doc, null, 2) })),
    ...protoFiles(p).map(({ nodeId, text }) => ({ name: `${safe(nodeId)}.proto`, text })),
    ...(a ? [{ name: 'asyncapi.json', text: JSON.stringify(a, null, 2) }] : []),
  ];
}

