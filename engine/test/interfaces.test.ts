import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyze } from '../analyze';
import { parseProject } from '../data';
import { asyncApiDoc, bodyBytes, csvCell, fastApiFiles, interfaceFiles, layoutCsv, openApiDocs, protoFiles, recordBytes, requestBytes, specAdvice, specGaps } from '../interfaces';
import { checkProject } from '../schema';
import { loadCatalog, loadLaws, loadPrices, loadProject } from '../io';
import type { Interface, Project } from '../schema';

const root = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const catalog = loadCatalog(root('data/catalog'));
const d = { catalog: catalog.byId, rules: catalog.rules, prices: loadPrices(root('data/prices')), laws: loadLaws(root('data/laws')) };
// global-commerce: 주문 API(N-03) → 세금 엔진(N-09) gRPC "QuoteTax", 주문 API → Kafka(N-04) 메시지 "orders.created"(쓰기 요청에서만)
const gc = loadProject(root('examples/global-commerce.json'), catalog.items);
const run = (p: Project) => analyze(p, d, '2026-10-25');
const iface = (x: Partial<Interface> & Pick<Interface, 'name' | 'kind' | 'path'>): Interface => ({ per_request: 1, on: 'all', request: [], response: [], errors: [], ...x });
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
  it('REST는 메서드, 메시지는 응답 없음 (경로 모양은 감사 6 P2부터 명세 점검 경고)', () => {
    expect(bad({ method: undefined })).toThrow('메서드');
    expect(bad({ path: 'x' })).not.toThrow();
    expect(bad({ kind: 'grpc', path: '세금', request: [{ name: 'a', type: 'string', required: true }] })).not.toThrow();
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

// 장부 앱: PWA → FastAPI(매출 저장·오늘 손익은 다 적음, 영수증 올리기는 비어 있음), 크론 → FastAPI(인증·에러 없음)
const ledger = loadProject(root('examples/ledger-fastapi.json'), catalog.items);
const ifcOf = (name: string) => ledger.edges.flatMap((e) => e.interfaces).find((i) => i.name === name)!;

describe('명세 점검', () => {
  it('요청 본문·응답·에러·인증이 비면 알림, 다 적으면 없음', () => {
    expect(specGaps(ifcOf('매출 저장'))).toEqual([]);
    expect(specGaps(ifcOf('영수증 올리기'))).toEqual(['요청 본문 필드가 없음', '응답 형식이 없음', '에러 응답이 없음 (실패할 때 무엇을 돌려줄지)', '인증 방식이 정해지지 않음']);
    expect(specGaps(ifcOf('마감 알림 보내기'))).toEqual(['에러 응답이 없음 (실패할 때 무엇을 돌려줄지)', '인증 방식이 정해지지 않음']);
  });
  it('경로 변수의 형식이 없으면 알림, DELETE는 응답이 없어도 됨, 메시지는 필드만 봄', () => {
    expect(specGaps(iface({ name: 'x', kind: 'rest', method: 'DELETE', path: '/a/{id}', auth: 'none', errors: [{ status: 404, description: '없음' }] }))).toEqual(['경로 변수 {id}의 형식이 없음 (문자열로 가정)']);
    expect(specGaps(iface({ name: 'm', kind: 'message', path: 't' }))).toEqual(['메시지 필드가 없음']);
  });
  it('받는 쪽 기술에 맞는 공유 방법: FastAPI는 뼈대와 자동 문서(/docs), 그 밖은 명세 먼저', () => {
    const fast = specAdvice(ledger).find((x) => x.nodeId === 'B-01')!;
    expect(fast.text).toContain('pydantic');
    expect(fast.text).toContain('/docs');
    expect(fast.file).toBe('B_01_fastapi.py');
    const go = specAdvice({ ...ledger, nodes: ledger.nodes.map((n) => (n.id === 'B-01' ? { ...n, primary: 'go_service' } : n)) }).find((x) => x.nodeId === 'B-01')!;
    expect(go.title).toContain('명세 먼저');
    expect(go.file).toBeUndefined();
  });
});

describe('OpenAPI 인증·에러', () => {
  const [{ doc }] = openApiDocs(ledger) as unknown as { doc: { paths: Record<string, Record<string, { security?: unknown; responses: Record<string, { content?: Record<string, unknown> }> }>>; components: { schemas: Record<string, unknown>; securitySchemes: Record<string, { scheme?: string }> } } }[];
  it('Bearer 인증은 securitySchemes와 작업의 security, 미정이면 security 없음', () => {
    expect(doc.components.securitySchemes.bearer.scheme).toBe('bearer');
    expect(doc.paths['/api/sales'].post.security).toEqual([{ bearer: [] }]);
    expect(doc.paths['/internal/notify'].post.security).toBeUndefined();
  });
  it('에러는 상태 코드마다 problem+json(공통 Problem 스키마)', () => {
    const r = doc.paths['/api/sales'].post.responses;
    // 받는 쪽이 FastAPI라 요청 검증 실패(422)도 problem+json으로 적는다
    expect(Object.keys(r)).toEqual(['200', '400', '401', '409', '422']);
    expect(r['422'].content!['application/problem+json']).toBeDefined();
    // 응답 필드가 없으면 본문 없는 204, 입력이 없으면 422도 없음
    expect(Object.keys(doc.paths['/api/receipts'].post.responses)).toEqual(['204']);
    expect(r['409'].content!['application/problem+json']).toEqual({ schema: { $ref: '#/components/schemas/Problem' } });
    expect(doc.components.schemas.Problem).toBeDefined();
  });
});

describe('FastAPI 뼈대', () => {
  const [f] = fastApiFiles(ledger);
  it('받는 노드가 FastAPI일 때만, pydantic 모델·엔드포인트·인증·에러 안내, 함수는 501', () => {
    expect(f.name).toBe('B_01_fastapi.py');
    expect(f.text).toContain('class PostApiSalesRequest(BaseModel):');
    expect(f.text).toContain('@app.post("/api/sales", response_model=PostApiSalesResponse');
    expect(f.text).toContain('_token: HTTPAuthorizationCredentials = Depends(require_bearer)');
    expect(f.text).toContain('raise ApiError(401, "인증이 필요합니다", "UNAUTHORIZED")');
    expect(f.text).toContain('@app.exception_handler(RequestValidationError)');
    expect(f.text).toContain('409: {"description": "SALES_DUPLICATE: 같은 날 매출이 이미 있음", "content": PROBLEM_JSON}');
    expect(f.text).toContain('@app.post("/api/receipts", status_code=204, response_class=Response');
    expect(f.text).toContain('app.openapi = custom_openapi');
    expect(f.text).toContain('date: Optional[str] = Query(None');
    expect(f.text).toContain('raise ApiError(409, "같은 날 매출이 이미 있음", "SALES_DUPLICATE")');
    expect(f.text).toContain('# TODO: 인증 방식이 정해지지 않았습니다');
    expect(f.text.match(/raise ApiError\(501, "구현 필요", "NOT_IMPLEMENTED"\)/g)!.length).toBe(4);
    expect(fastApiFiles(gc)).toEqual([]);
    expect(interfaceFiles(ledger).map((x) => x.name)).toEqual(['openapi-B_01.json', 'B_01_fastapi.py']);
  });
  it('파이썬 예약어 필드는 이름 뒤에 _를 붙이고 원래 이름을 alias로', () => {
    const p = withEdge(ledger, 'U-01', 'B-01', [iface({ name: 'k', kind: 'rest', method: 'POST', path: '/k', request: [{ name: 'from', type: 'string', required: true }] })]);
    const text = fastApiFiles(p)[0].text;
    expect(text).toContain('from_: str = Field(..., alias="from")');
    expect(text).toContain('model_config = ConfigDict(populate_by_name=True)');
    expect(text).toContain('from pydantic import BaseModel, ConfigDict, Field');
  });
});

describe('파일·전문 (고정장·가변장)', () => {
  const fields = [
    { name: 'acct', type: 'string' as const, required: true, length: 10 },
    { name: 'amount', type: 'integer' as const, required: true, length: 13 },
  ];
  const fixed = iface({ name: '매출 파일', kind: 'file', path: 'TR0101', request: fields,
    record: { format: 'fixed', delimiter: ',', encoding: 'euc-kr', newline: 'crlf', header: false } });

  it('고정장 레코드 길이 = 필드 길이 합 + 줄바꿈, 하나라도 길이가 없으면 모름', () => {
    expect(recordBytes(fixed)).toBe(25);
    expect(requestBytes(fixed)).toBe(25);
    const missing = { ...fixed, request: [fields[0], { ...fields[1], length: undefined }] };
    expect(recordBytes(missing)).toBeUndefined();
    expect(specGaps(missing)).toContain('고정장 필드 길이가 없음: amount');
  });

  it('가변장 = 값 + 구분자 + 줄바꿈', () => {
    const csv = { ...fixed, record: { ...fixed.record!, format: 'delimited' as const, newline: 'lf' as const },
      request: [{ ...fields[0], avg_bytes: 8 }, { ...fields[1], avg_bytes: 5 }] };
    expect(recordBytes(csv)).toBe(8 + 5 + 1 + 1);
  });

  it('레이아웃 표: 시작·끝 위치, 숫자는 오른쪽 0 채움, 문자는 왼쪽 공백 채움', () => {
    const lines = layoutCsv(fixed, '주문 API', '정산').split('\r\n');
    expect(lines[0].startsWith('\uFEFF')).toBe(true);
    expect(lines).toContain('1,acct,,string,Y,10,1,10,왼쪽,공백');
    expect(lines).toContain('2,amount,,integer,Y,13,11,23,오른쪽,0');
    // 데이터 길이 = 마지막 끝 위치, 레코드 길이 = + CRLF
    expect(lines).toContain('"레코드 길이(바이트, 줄바꿈 포함)",25');
    expect(lines).toContain('"데이터 길이(바이트, 줄바꿈 제외)",23');
  });

  it('내보내기에 layout CSV가 들어가고, 응답이 있으면 오류', () => {
    const p = withEdge(gc, 'N-03', 'N-04', [fixed]);
    expect(interfaceFiles(p).map((f) => f.name)).toContain('layout-N_03-N_04-TR0101.csv');
    expect(checkProject(withEdge(gc, 'N-03', 'N-04', [{ ...fixed, response: fields }]), catalog.items).join()).toMatch(/파일·전문은 응답이 없음/);
  });

  it('길이 없는 필드부터 뒤는 위치를 모름 (시작·끝·맞춤·채움 비움), 크기는 필드별 길이·평균·예시값 합으로 어림', () => {
    const gap = { ...fixed, request: [fields[0], { name: 'memo', type: 'string' as const, required: true }, fields[1]] };
    const lines = layoutCsv(gap, 'A', 'B').split('\r\n');
    expect(lines).toContain('1,acct,,string,Y,10,1,10,왼쪽,공백');
    expect(lines).toContain('2,memo,,string,Y,,,,,');
    expect(lines).toContain('3,amount,,integer,Y,13,,,,');
    // 10 + (길이 없는 문자열 예시 32) + 13 + CRLF 2
    expect(requestBytes(gap)).toBe(57);
    // 가변장에서 바꿔 남은(화면에 안 보이는) 평균 바이트는 고정장 어림에 쓰지 않음
    expect(requestBytes({ ...gap, request: [fields[0], { name: 'memo', type: 'string' as const, required: true, avg_bytes: 500 }, fields[1]] })).toBe(57);
    expect(requestBytes({ ...gap, record: undefined, request: [fields[0], { name: 'memo', type: 'string' as const, required: true, avg_bytes: 500 }, fields[1]] })).toBe(525);
  });

  it('내보낼 파일 이름이 겹치면 -2, -3 (한글 ID → ___, 대소문자만 다른 이름도)', () => {
    const f = (path: string) => ({ ...fixed, name: path, path });
    const p = withEdge(gc, 'N-03', 'N-04', [f('주문.txt'), f('결제.txt'), f('ORD-01'), f('ORD_01'), f('ord_01')]);
    expect(interfaceFiles(p).filter((x) => x.name.startsWith('layout-')).map((x) => x.name)).toEqual([
      'layout-N_03-N_04-___txt.csv', 'layout-N_03-N_04-___txt-2.csv', 'layout-N_03-N_04-ORD_01.csv', 'layout-N_03-N_04-ORD_01-2.csv', 'layout-N_03-N_04-ord_01-3.csv',
    ]);
  });

  it('CSV 칸이 = + - @로 시작하면 앞에 \' (엑셀 수식 막기), 진짜 숫자는 그대로', () => {
    expect(['=1+1', '+82 10', '-x', '@a', '-1', -0.5, '-0.5', 'a=b'].map(csvCell)).toEqual(["'=1+1", "'+82 10", "'-x", "'@a", '-1', '-0.5', '-0.5', 'a=b']);
    // 탭·CR로 시작하는 칸도 (숫자처럼 보여도)
    expect(['\t5', '\t=1', '\rx'].map(csvCell)).toEqual(["'\t5", "'\t=1", `"'\rx"`]);
  });
});

describe('내보내기: 경로 모양이 틀려도 파일은 깨지지 않음 (리뷰 6)', () => {
  const two = (interfaces: Interface[]): Project => ({ ...gc, edges: [{ from: 'N-03', to: 'N-09', sync: true, callRatio: 1, carries: 'all', rtt_ms: 0, interfaces }] } as Project);
  it('REST 경로에 / 를 붙이고, gRPC 이름은 식별자로', () => {
    const rest = openApiDocs(two([iface({ name: 'a', kind: 'rest', method: 'GET', path: 'orders' })]));
    expect(Object.keys((rest[0].doc as { paths: object }).paths)).toEqual(['/orders']);
    const proto = protoFiles(two([iface({ name: 'b', kind: 'grpc', path: 'Create Order' }), iface({ name: 'c', kind: 'grpc', path: '' })]))[0].text;
    expect(proto).toContain('rpc CreateOrder (CreateOrderRequest) returns (CreateOrderResponse);');
    expect(proto).toContain('rpc Method1 (Method1Request) returns (Method1Response);');
  });
  it('FastAPI 모델 이름이 겹치지 않게 operationId를 고름', () => {
    const doc = openApiDocs(two(['/orders/{id}', '/orders/id', '/orders/id2'].map((path, k) => iface({ name: `r${k}`, kind: 'rest', method: 'GET', path }))))[0].doc as { paths: Record<string, { get: { operationId: string } }> };
    const ids = Object.values(doc.paths).map((x) => x.get.operationId);
    const pas = ids.map((s) => s.split('_').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(''));
    expect(new Set(pas).size).toBe(3);
  });
});

describe('감사 6: 명세 파일 정확성', () => {
  const two = (interfaces: Interface[]): Project => ({ ...gc, edges: [{ from: 'N-03', to: 'N-09', sync: true, callRatio: 1, carries: 'all', rtt_ms: 0, interfaces }] } as Project);
  it('FastAPI: 이름의 \\는 docstring을 깨지 않고, 파이썬 이름이 못 되는 경로 변수·필드는 alias', () => {
    const p = withEdge(ledger, 'U-01', 'B-01', [iface({ name: 'k', kind: 'rest', method: 'POST', path: '/k/{1}/{class}/{order-id}',
      request: [{ name: '_id', type: 'string', required: true }], response: [{ name: 'model_config', type: 'string', required: true }] })]);
    const text = fastApiFiles({ ...p, nodes: p.nodes.map((n) => (n.id === 'U-01' ? { ...n, name: 'C:\\New\\x' } : n)) })[0].text;
    expect(text).toContain('    "부르는 노드: C:\\\\New\\\\x"');
    // Starlette는 영문 식별자 경로 변수만 받아 경로에서도 이름을 바꾸고, 예약어만 alias
    expect(text).toContain('@app.post("/k/{f_N1}/{class}/{f_order_id}"');
    expect(text).toContain('f_N1: str, class_: Annotated[str, Path(alias="class")], f_order_id: str, body:');
    expect(text).toContain('f__id: str = Field(..., alias="_id")');
    expect(text).toContain('f_model_config: str = Field(..., alias="model_config")');
    expect(text).toContain('from typing import Annotated, Any, Optional');
    expect(text).toContain('from fastapi import Depends, FastAPI, Path, Query, Request');
  });
  it('FastAPI 함수 인자 이름은 겹치지 않음 (한글 경로 변수 둘, {body}와 본문)', () => {
    const p = withEdge(ledger, 'U-01', 'B-01', [iface({ name: 'k', kind: 'rest', method: 'POST', path: '/o/{주문}/{번호}/{body}', auth: 'bearer',
      request: [{ name: 'x', type: 'string', required: true }] })]);
    const text = fastApiFiles(p)[0].text;
    expect(text).toContain('@app.post("/o/{f___}/{f____2}/{body}"');
    expect(text).toContain('(f___: str, f____2: str, body: str, body_2: PostOBodyRequest, _token: HTTPAuthorizationCredentials');
    expect(specGaps(p.edges.find((e) => e.from === 'U-01' && e.to === 'B-01')!.interfaces.at(-1)!).join()).toContain('경로 변수 {주문}가 영문 식별자가 아님');
  });
  it('경로 변수 {order-id}·{주문}도 OpenAPI parameter가 됨', () => {
    const doc = openApiDocs(two([iface({ name: 'a', kind: 'rest', method: 'GET', path: '/o/{order-id}/{주문}' })]))[0].doc as { paths: Record<string, { get: { parameters: { name: string; in: string }[] } }> };
    expect(doc.paths['/o/{order-id}/{주문}'].get.parameters.filter((x) => x.in === 'path').map((x) => x.name)).toEqual(['order-id', '주문']);
  });
  it('AsyncAPI: 같은 토픽에 다른 메시지를 보내면 둘 다 남고, 작업은 자기 메시지를 가리킴', () => {
    const created = gc.edges.find((e) => e.from === 'N-03' && e.to === 'N-04')!.interfaces.find((i) => i.kind === 'message')!;
    const cancel = iface({ name: '주문 취소됨', kind: 'message', path: created.path, request: [{ name: 'cancel_reason', type: 'string', required: true }] });
    const p = { ...gc, edges: [...gc.edges, { from: 'N-09', to: 'N-04', sync: false, callRatio: 1, carries: 'all', rtt_ms: 0, interfaces: [cancel] }] } as Project;
    const doc = asyncApiDoc(p) as { channels: Record<string, { messages: Record<string, { name: string }> }>; operations: Record<string, { messages: { $ref: string }[] }> };
    const ch = Object.values(doc.channels).find((c) => Object.values(c.messages).some((m) => m.name === '주문 취소됨'))!;
    expect(Object.values(ch.messages).map((m) => m.name)).toEqual([created.name, '주문 취소됨']);
    const send = Object.entries(doc.operations).find(([k]) => k.startsWith('N_09_send_'))![1];
    expect(send.messages.map((m) => m.$ref)).toEqual([expect.stringMatching(/_message_2$/)]);
  });
  it('proto: 바꾼 이름이 겹치면 _2 (원래 이름이 같을 때만 하나로)', () => {
    const rpcs = (paths: string[]) => protoFiles(two(paths.map((path, k) => iface({ name: `g${k}`, kind: 'grpc', path }))))[0].text.match(/rpc \w+/g);
    expect(rpcs(['주문 생성', '결제'])).toEqual(['rpc Method1', 'rpc Method1_2']);
    expect(rpcs(['CreateOrder', 'create-order', 'CreateOrder'])).toEqual(['rpc CreateOrder', 'rpc CreateOrder_2']);
  });
});
