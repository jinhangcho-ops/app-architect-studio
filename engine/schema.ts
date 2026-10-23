// 사람이 고치는 JSON 파일(카탈로그·규칙·프로젝트)의 검증. 조건식은 읽을 때 미리 해석해 오류를 일찍 잡는다.
import { z } from 'zod';
import { parse } from './expr';
import { LAYERS } from './model';

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

export const Project = z.object({
  name: z.string(),
  nodes: z.array(z.object({
    id: z.string(),
    name: z.string(),
    layer: Layer,
    primary: z.string().optional(),
    extras: z.array(z.string()).default([]),
    spec: Spec.optional(),
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
  })).default([]),
});

export type Spec = z.infer<typeof Spec>;
export type Threshold = z.infer<typeof Threshold>;
export type CatalogItem = z.infer<typeof CatalogItem>;
export type Rule = z.infer<typeof Rule>;
export type Project = z.infer<typeof Project>;
export type ProjectNode = Project['nodes'][number];

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
