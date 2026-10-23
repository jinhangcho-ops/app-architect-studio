import { describe, expect, it } from 'vitest';
import { parseProject } from '../../engine/data';
import { catalog, examples } from './data';
import { applyAlternative, run, updateNode } from './edit';
import { canEnter } from './NodeInside';
import { partsOf } from './PartsInside';

const today = '2026-10-24';
const ex = examples.find((e) => e.name === 'global-commerce.json')!;
const p0 = parseProject(ex.data, catalog.items, ex.name);
const a0 = run(p0, today).analysis!;

describe('백엔드·게이트웨이·워커 블록 안 (부품)', () => {
  it('부품은 주 항목 다음 보조 항목, 판정은 바깥 판정과 같음', () => {
    const parts = partsOf(p0, a0, catalog.byId, 'N-03');
    expect(parts.map((x) => [x.itemId, x.role])).toEqual([['api_autoscale', '주'], ['transactional_outbox', '보조'], ['idempotency_key', '보조']]);
    const j = a0.judgements.find((x) => x.nodeId === 'N-03')!;
    expect(parts.map((x) => x.verdict)).toEqual(j.items.map((x) => x.verdict));
  });

  it('대안은 같은 역할·이 레이어에 붙는 것만, 이미 쓰는 항목과 안 됨은 빠짐', () => {
    for (const id of ['N-03', 'N-05', 'N-08', 'N-09']) {
      const n = p0.nodes.find((x) => x.id === id)!;
      for (const part of partsOf(p0, a0, catalog.byId, id)) {
        for (const alt of part.alternatives) {
          const it = catalog.byId.get(alt.id)!;
          expect(it.role).toBe(part.role);
          expect(it.attaches_to).toContain(n.layer);
          expect([n.primary, ...n.extras]).not.toContain(alt.id);
          expect(alt.verdict).not.toBe('fail');
        }
      }
    }
  });

  it('대안으로 교체하고 보조 항목을 빼도 분석이 계속됨', () => {
    const worker = partsOf(p0, a0, catalog.byId, 'N-05')[0];
    expect(worker.alternatives.length).toBeGreaterThan(0);
    const swapped = applyAlternative(p0, 'N-05', worker.itemId, worker.alternatives[0].id);
    expect(swapped.nodes.find((n) => n.id === 'N-05')!.primary).toBe(worker.alternatives[0].id);
    expect(run(swapped, today).error).toBeUndefined();
    expect(run(updateNode(p0, 'N-03', { extras: ['idempotency_key'] }), today).error).toBeUndefined();
  });

  it('모든 블록은 세부 구성으로 들어갈 수 있음', () => {
    expect(['ui', 'gateway', 'backend', 'cache', 'queue', 'batch', 'db', 'external', 'analytics'].every((l) => canEnter(l))).toBe(true);
    expect(canEnter(undefined)).toBe(false);
  });
});
