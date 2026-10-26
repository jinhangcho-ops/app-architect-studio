// 리뷰 5·감사 6 (A6 엔진): 화면 편집으로 생기는 상태를 열기·계산·내보내기가 받아 주는지
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { numberRangeWhy, parseProject, readProject } from '../data';
import { asyncApiDoc, fastApiFiles, openApiDocs, specGaps } from '../interfaces';
import { Project, checkProject, type Interface } from '../schema';
import { loadCatalog } from '../io';
import { traffic } from '../traffic';

const root = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const catalog = loadCatalog(root('data/catalog'));
const gc = () => JSON.parse(readFileSync(root('examples/global-commerce.json'), 'utf8'));
const actions = () => JSON.parse(readFileSync(root('examples/actions.json'), 'utf8'));
const iface = (x: Partial<Interface> & Pick<Interface, 'name' | 'kind' | 'path'>): Interface => ({ per_request: 1, on: 'all', request: [], response: [], errors: [], ...x });

describe('P1 페르소나 비율 합은 계산 배너 오류 (zod 아님)', () => {
  it('합이 1이 아닌 파일도 열리고, checkProject·parseProject는 거부', () => {
    const raw = gc();
    raw.personas[0].share = 0.01;
    const p = readProject(raw, catalog.items);
    expect(checkProject(p, catalog.items).join()).toContain('페르소나 비율의 합은 1이어야 함');
    expect(() => parseProject(raw, catalog.items)).toThrow('페르소나 비율의 합');
  });
});

describe('P1 readProject: 화면에서 비운·잘못 친 칸을 채워 엶', () => {
  it('인터페이스 경로·설명 비움, 필드 이름 한글·비움, 에러 코드 공백', () => {
    const raw = gc();
    const e = raw.edges.find((x: { interfaces?: unknown[] }) => x.interfaces?.length);
    e.interfaces = [
      { name: 'a', kind: 'rest', method: 'GET', path: '', request: [{ name: '주문', type: 'string' }, { name: '', type: 'string' }, { name: 'field1', type: 'string' }], errors: [{ status: 400, code: 'A B', description: '' }] },
      { name: 'b', kind: 'grpc', path: '' }, { name: 'c', kind: 'message', path: '' }, { name: 'd', kind: 'file', path: '' },
    ];
    const notes: string[] = [];
    const p = readProject(raw, catalog.items, 'x', notes);
    const out = p.edges.find((x) => x.interfaces.length)!.interfaces;
    expect(out.map((i) => i.path)).toEqual(['/path', 'Method1', 'topic.name', 'FILE_ID']);
    expect(out[0].request.map((f) => f.name)).toEqual(['field2', 'field3', 'field1']);
    expect(out[0].errors[0]).toEqual({ status: 400, description: '-' });
    expect(notes).toHaveLength(8);
  });

  it('테이블 컬럼을 모두 지우면 id bigint 하나, 인덱스 컬럼이 비면 인덱스를 지움', () => {
    const raw = actions();
    const db = raw.nodes.find((n: { id: string }) => n.id === 'db');
    db.tables[0].columns = [];
    db.tables[1].indexes = [{ name: 'i1', columns: [] }, ...(db.tables[1].indexes ?? []), { name: 'i2', columns: [] }];
    const before = (db.tables[1].indexes as unknown[]).length;
    const notes: string[] = [];
    const p = readProject(raw, catalog.items, 'x', notes);
    const t = p.nodes.find((n) => n.id === 'db')!.tables;
    expect(t[0].columns).toEqual([expect.objectContaining({ name: 'id', type: 'bigint' })]);
    expect(t[1].indexes).toHaveLength(before - 2);
    expect(notes).toHaveLength(3);
  });
});

describe('N3 필수 숫자 칸 범위 밖은 경계값으로 맞춰 엶', () => {
  it('users -5 → 1, perf.workers 0 → 1, errors[].status 4 → 400, 정수 아님은 반올림', () => {
    const raw = gc();
    raw.scale.users = -5;
    const n = raw.nodes.find((x: { perf?: unknown }) => x.perf);
    n.perf.workers = 0;
    n.replicas = 2.4;
    const e = raw.edges.find((x: { interfaces?: unknown[] }) => x.interfaces?.length);
    e.interfaces[0].errors = [{ status: 4, description: 'x' }];
    const notes: string[] = [];
    const p = readProject(raw, catalog.items, 'x', notes);
    expect(p.scale!.users).toBe(1);
    expect(p.nodes.find((x) => x.id === n.id)!.perf!.workers).toBe(1);
    // 기본값이 있는 칸은 지금처럼 빼서 기본값
    expect(p.nodes.find((x) => x.id === n.id)!.replicas).toBe(1);
    expect(p.edges.find((x) => x.interfaces.length)!.interfaces[0].errors[0].status).toBe(400);
    expect(notes.join('\n')).toContain('scale.users = -5: 0보다 커야 함 → 1 값으로 맞췄습니다');
    expect(notes).toHaveLength(4);
  });

  it('필수 정수 칸 2.6은 3, 0.4는 반올림 뒤 0이 되어 다시 1로', () => {
    for (const [v, want] of [[2.6, 3], [0.4, 1]]) {
      const raw = gc();
      raw.nodes.find((x: { perf?: unknown }) => x.perf).perf.workers = v;
      expect(readProject(raw, catalog.items).nodes.find((x) => x.perf)!.perf!.workers).toBe(want);
    }
  });
});

describe('N5 이유 문구 맞춤법', () => {
  it('받침에 맞게', () => {
    const issues = (v: unknown, s: z.ZodType) => s.safeParse(v).error!.issues.map(numberRangeWhy);
    expect(issues(-1, z.number().min(0))).toEqual(['0 이상이어야 함']);
    expect(issues(2, z.number().max(1))).toEqual(['1 이하여야 함']);
    expect(issues(0, z.number().positive())).toEqual(['0보다 커야 함']);
    expect(issues(1, z.number().lt(1))).toEqual(['1보다 작아야 함']);
    expect(issues(1.5, z.number().int())).toEqual(['정수여야 함']);
  });
});

describe('N6 growth.months 상한 240', () => {
  it('241은 범위 밖', () => {
    expect(Project.safeParse({ name: 'p', nodes: [], growth: { monthly_rate: 0.1, months: 241 } }).success).toBe(false);
    expect(Project.safeParse({ name: 'p', nodes: [], growth: { monthly_rate: 0.1, months: 240 } }).success).toBe(true);
  });
});

describe('P2 경로 모양은 명세 점검(⚠️), 막는 오류 아님', () => {
  it('REST 경로가 /로 시작하지 않음, gRPC 메서드 이름이 영문 식별자가 아님', () => {
    expect(specGaps(iface({ name: 'r', kind: 'rest', method: 'GET', path: 'topic.name' })).join()).toContain('/로 시작');
    expect(specGaps(iface({ name: 'g', kind: 'grpc', path: '/path' })).join()).toContain('영문 식별자');
    expect(specGaps(iface({ name: 'g', kind: 'grpc', path: 'Quote' })).join()).not.toContain('영문 식별자');
  });
});

const proj = (edges: Project['edges'], extra: Partial<Project> = {}): Project => Project.parse({
  name: 'p',
  nodes: [{ id: 'api', name: 'API', layer: 'backend', primary: 'fastapi' }, { id: 'svc', name: 'SVC', layer: 'backend', primary: 'fastapi' },
    { id: 'q', name: 'Q', layer: 'queue' }, { id: 'w', name: 'W', layer: 'batch' }, { id: 'w2', name: 'W2', layer: 'batch' }],
  edges, ...extra,
});

describe('P3·P4 AsyncAPI', () => {
  it('안전 이름이 같고 주소가 다르면 _2, 주소가 같으면 한 채널', () => {
    const p = proj([
      { from: 'api', to: 'q', sync: false, interfaces: [iface({ name: 'm', kind: 'message', path: 'order.created' }), iface({ name: 'm2', kind: 'message', path: 'order-created' })] },
      { from: 'svc', to: 'q', sync: false, interfaces: [iface({ name: 'm3', kind: 'message', path: 'order.created' })] },
    ] as Project['edges']);
    const doc = asyncApiDoc(p) as { channels: Record<string, { address: string }> };
    expect(Object.fromEntries(Object.entries(doc.channels).map(([k, v]) => [k, v.address]))).toEqual({ order_created: 'order.created', order_created_2: 'order-created' });
  });

  it('큐로 가는 메시지만 큐 다음 노드가 받고, 아니면 연결선 도착 노드가 받음', () => {
    const p = proj([
      { from: 'api', to: 'q', sync: false, interfaces: [iface({ name: 'm', kind: 'message', path: 'a' })] },
      { from: 'q', to: 'w' },
      { from: 'api', to: 'w2', sync: false, interfaces: [iface({ name: 'd', kind: 'message', path: 'b' })] },
      { from: 'w2', to: 'svc' },
    ] as Project['edges']);
    const ops = Object.keys((asyncApiDoc(p) as { operations: object }).operations).sort();
    expect(ops).toEqual(['api_send_a', 'api_send_b', 'w2_receive_b', 'w_receive_a']);
  });
});

describe('P6 operationId 겹침', () => {
  it('GET /orders/{id}와 GET /orders/id는 _2, FastAPI 함수·모델 이름도 같게', () => {
    const p = proj([{ from: 'api', to: 'svc', interfaces: [
      iface({ name: 'a', kind: 'rest', method: 'GET', path: '/orders/{id}', response: [{ name: 'x', type: 'string', required: true }] }),
      iface({ name: 'b', kind: 'rest', method: 'GET', path: '/orders/id', response: [{ name: 'y', type: 'string', required: true }] }),
    ] }] as Project['edges']);
    const doc = openApiDocs(p)[0].doc as { paths: Record<string, Record<string, { operationId: string }>> };
    expect([doc.paths['/orders/{id}'].get.operationId, doc.paths['/orders/id'].get.operationId]).toEqual(['get_orders_id', 'get_orders_id_2']);
    const py = fastApiFiles(p)[0].text;
    expect(py).toContain('def get_orders_id(');
    expect(py).toContain('def get_orders_id_2(');
    expect(py).toContain('class GetOrdersId2Response(BaseModel)');
  });
});

describe('P7 표본이 작으면 트래픽 가정에 경고', () => {
  const p = (users: number) => Project.parse({ name: 'p', nodes: [], scale: { users }, personas: [{ name: 'a', share: 1, pattern: 'regular' }] });
  it('10명이면 경고, 10만 명이면 없음', () => {
    expect(traffic(p(10))!.assumptions.join()).toContain('표본이 작아 피크가 날마다 크게 다를 수 있음');
    expect(traffic(p(100_000))!.assumptions).toEqual([]);
  });
});
