import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyze } from '../analyze';
import { parseProject } from '../data';
import { asyncApiDoc, bodyBytes, interfaceFiles, openApiDocs, protoFiles, requestBytes } from '../interfaces';
import { loadCatalog, loadLaws, loadPrices, loadProject } from '../io';
import type { Interface, Project } from '../schema';

const root = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const catalog = loadCatalog(root('data/catalog'));
const d = { catalog: catalog.byId, rules: catalog.rules, prices: loadPrices(root('data/prices')), laws: loadLaws(root('data/laws')) };
// global-commerce: 주문 API(N-03) → 세금 엔진(N-09) gRPC "QuoteTax", 주문 API → Kafka(N-04) 메시지 "orders.created"(쓰기 요청에서만)
const gc = loadProject(root('examples/global-commerce.json'), catalog.items);
const run = (p: Project) => analyze(p, d, '2026-10-25');
const iface = (x: Partial<Interface> & Pick<Interface, 'name' | 'kind' | 'path'>): Interface => ({ per_request: 1, on: 'all', request: [], response: [], ...x });
const withEdge = (p: Project, from: string, to: string, interfaces: Interface[]): Project =>
  ({ ...p, edges: p.edges.map((e) => (e.from === from && e.to === to ? { ...e, interfaces } : e)) });
// 게이트웨이 → 주문 API에 REST 두 개: 읽기 요청마다 주문 조회, 쓰기 요청마다 주문 만들기
const rest = withEdge(gc, 'N-08', 'N-03', [
  iface({ name: '주문 조회', kind: 'rest', method: 'GET', path: '/orders/{order_id}', on: 'read',
    request: [{ name: 'order_id', type: 'uuid', required: true }, { name: 'lang', type: 'string', required: false }], response: [{ name: 'status', type: 'string', required: true }] }),
  iface({ name: '주문 만들기', kind: 'rest', method: 'POST', path: '/orders', on: 'write',
    request: [{ name: 'amount', type: 'number', required: true, description: '금액' }], response: [{ name: 'order_id', type: 'uuid', required: true }] }),
]);

describe('인터페이스 명세로 부하 계산', () => {
  it('쓰기 요청에서만 보내는 메시지는 보내는 노드의 쓰기 요청만큼 큐로 감', () => {
    const a = run(gc);
    expect(a.nodes['N-04'].load!.rps.normal).toBeCloseTo(a.nodes['N-03'].load!.writeRps.normal);
    expect(a.nodes['N-04'].load!.writeRps.normal).toBeCloseTo(a.nodes['N-04'].load!.rps.normal);
  });

  it('읽기 요청마다 GET 1번 + 쓰기 요청마다 POST 1번이면 받는 노드의 부하·쓰기는 명세 전과 같음', () => {
    const before = run(gc).nodes['N-03'].load!, after = run(rest).nodes['N-03'].load!;
    expect(after.rps.normal).toBeCloseTo(before.rps.normal);
    expect(after.writeRps.normal).toBeCloseTo(before.writeRps.normal);
  });

  it('호출 수를 두 배로 적으면 받는 노드 부하도 두 배', () => {
    const twice = withEdge(gc, 'N-03', 'N-09', gc.edges.find((e) => e.to === 'N-09')!.interfaces.map((i) => ({ ...i, per_request: 2 })));
    expect(run(twice).nodes['N-09'].load!.rps.normal).toBeCloseTo(run(gc).nodes['N-09'].load!.rps.normal * 2);
  });

  it('크기: JSON은 { } + Σ(키 + 4 + 값), protobuf는 Σ(태그 1 + 값), 실측 크기가 있으면 그 값', () => {
    expect(bodyBytes([{ name: 'id', type: 'uuid', required: true }], 'rest')).toBe(2 + 2 + 4 + 38);
    expect(bodyBytes([{ name: 'id', type: 'integer', required: true }], 'grpc')).toBe(1 + 4);
    expect(requestBytes(iface({ name: 'x', kind: 'rest', path: '/x', method: 'GET', request_bytes: 500 }))).toBe(500);
  });

  it('리전이 다른 연결선의 전송량은 명세 크기로: 크기를 키우면 리전 간 전송비가 늚', () => {
    // 주문 API(서울) → 원장 DB(도쿄)는 명세가 없어 그대로, 세금 엔진은 같은 리전이라 0 → 도쿄 쪽에 명세를 붙여 본다
    const spec = (bytes: number) => withEdge(gc, 'N-03', 'N-06', [iface({ name: '원장 쓰기', kind: 'grpc', path: 'WriteLedger', on: 'write', op: 'write', request_bytes: bytes })]);
    const small = run(spec(100)).cost!.parts['리전 간 전송'].value, big = run(spec(100000)).cost!.parts['리전 간 전송'].value;
    expect(big).toBeGreaterThan(small);
  });
});

describe('명세 검증', () => {
  const bad = (i: Partial<Interface>) => () => parseProject(withEdge(gc, 'N-08', 'N-03', [iface({ name: 'x', kind: 'rest', method: 'GET', path: '/x', ...i })]), catalog.items);
  it('REST는 메서드·/로 시작하는 경로, gRPC는 영문 메서드 이름, 메시지는 응답 없음', () => {
    expect(bad({ method: undefined })).toThrow('메서드');
    expect(bad({ path: 'x' })).toThrow('/로 시작');
    expect(bad({ kind: 'grpc', path: '세금' })).toThrow('영문 식별자');
    expect(bad({ kind: 'message', path: 't', response: [{ name: 'a', type: 'string', required: true }] })).toThrow('응답이 없음');
    expect(bad({ request: [{ name: '금액', type: 'number', required: true }] })).toThrow('영문');
  });
});

describe('표준 파일로 내보내기', () => {
  it('OpenAPI: 받는 노드마다, 경로 변수는 path, GET의 나머지는 query, POST는 본문, 부르는 노드 표시', () => {
    const [{ doc }] = openApiDocs(rest) as unknown as { doc: { openapi: string; paths: Record<string, Record<string, Record<string, unknown>>> } }[];
    expect(doc.openapi).toBe('3.0.3');
    const get = doc.paths['/orders/{order_id}'].get as { parameters: { name: string; in: string }[]; 'x-callers': string[] };
    expect(get.parameters.map((x) => `${x.in}:${x.name}`)).toEqual(['path:order_id', 'query:lang']);
    expect(get['x-callers']).toEqual(['글로벌 Edge·L7 게이트웨이 (N-08)']);
    const post = doc.paths['/orders'].post as { requestBody: { content: { 'application/json': { schema: { required: string[]; properties: Record<string, unknown> } } } } };
    expect(post.requestBody.content['application/json'].schema.properties.amount).toEqual({ type: 'number', description: '금액' });
  });

  it('AsyncAPI: 토픽마다 채널, 보내는 노드는 send, 큐에서 받는 노드는 receive', () => {
    const doc = asyncApiDoc(gc) as unknown as { asyncapi: string; channels: Record<string, { address: string }>; operations: Record<string, { action: string; 'x-node': string }> };
    expect(doc.asyncapi).toBe('3.0.0');
    expect(doc.channels.orders_created.address).toBe('orders.created');
    const ops = Object.values(doc.operations).map((o) => `${o.action}:${o['x-node']}`);
    expect(ops).toContain('send:코어 주문 API (N-03)');
    expect(ops).toContain('receive:멀티마켓 정산 워커 (N-05)');
    expect(ops).toContain('receive:데이터 레이크하우스 (N-10)');
  });

  it('proto: 서비스와 rpc, 요청·응답 메시지, 필수가 아닌 값은 optional', () => {
    const [{ text }] = protoFiles(gc);
    expect(text).toContain('syntax = "proto3";');
    expect(text).toContain('rpc QuoteTax (QuoteTaxRequest) returns (QuoteTaxResponse);');
    expect(text).toContain('int64 tenant_id = 1;');
    expect(text).toContain('optional string rule_version = 4;');
  });

  it('내보낼 파일 이름', () => {
    // REST는 주문 API로(openapi-N_03), gRPC는 세금 엔진으로(N_09.proto), 메시지는 한 파일
    expect(interfaceFiles(rest).map((f) => f.name)).toEqual(['openapi-N_03.json', 'N_09.proto', 'asyncapi.json']);
  });
});
