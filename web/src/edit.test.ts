import { describe, expect, it } from 'vitest';
import { parseProject } from '../../engine/data';
import { catalog, examples } from './data';
import { addEdge, addNode, applyAlternative, removeNode, run, setVar, updateNode, worstVerdict } from './edit';
import { autoLayout } from './layout';

const today = '2026-10-23';
const ex = examples.find((e) => e.name === 'phase3.json')!;
const base = parseProject(ex.data, catalog.items, ex.name);
const verdictOf = (p: typeof base, id: string) => worstVerdict(run(p, today).analysis!.judgements.find((j) => j.nodeId === id));

describe('관문: 노드 항목이나 사용자 수를 바꾸면 판정이 바로 바뀜', () => {
  it('예시 프로젝트가 화면 데이터로 그대로 분석됨', () => {
    const r = run(base, today);
    expect(r.error).toBeUndefined();
    expect(r.analysis!.judgements).toHaveLength(base.nodes.length);
  });

  it('DB를 SQLite로 바꾸면 안 됨, 대안 적용으로 PostgreSQL로 돌리면 다시 됨', () => {
    const sqlite = updateNode(base, 'db', { primary: 'sqlite' });
    expect(verdictOf(sqlite, 'db')).toBe('fail');
    expect(verdictOf(applyAlternative(sqlite, 'db', 'sqlite', 'postgresql'), 'db')).not.toBe('fail');
  });

  it('활성 사용자를 첫 병목의 한계보다 늘리면 그 노드가 이벤트 피크에서 걸려 조건부가 됨', () => {
    const before = run(base, today).analysis!;
    const { nodeId, limitUsers } = before.bottleneck!;
    expect(verdictOf(base, nodeId)).toBe('ok');
    const bigger = { ...base, scale: { ...base.scale!, users: limitUsers.value * 1.5 } };
    expect(verdictOf(bigger, nodeId)).toBe('conditional');
  });

  it('입력이 틀리면 계산하지 않고 오류를 돌려줌', () => {
    const bad = { ...base, personas: [{ ...base.personas[0], share: 0.3 }] };
    expect(run(bad, today).error).toContain('페르소나 비율의 합');
  });
});

describe('편집 동작', () => {
  it('노드 추가는 겹치지 않는 id와 기본값을 채움', () => {
    const { project, id } = addNode(base, 'cache');
    expect(id).toBe('cache-1');
    expect(project.nodes.at(-1)).toMatchObject({ id: 'cache-1', layer: 'cache', replicas: 1, extras: [] });
  });

  it('같은 연결선·자기 자신 연결은 추가하지 않고, 노드를 지우면 연결선도 지움', () => {
    const e = base.edges[0];
    expect(addEdge(base, e.from, e.to)).toBe(base);
    expect(addEdge(base, 'api', 'api')).toBe(base);
    const removed = removeNode(base, 'api');
    expect(removed.edges.some((x) => x.from === 'api' || x.to === 'api')).toBe(false);
  });

  it('직접 넣는 값은 평소·이벤트에 같이 들어가고 비우면 지워짐', () => {
    const p = setVar(base, 'api', 'service_time_cv', 2);
    expect(p.nodes.find((n) => n.id === 'api')!.vars).toMatchObject({ normal: { service_time_cv: 2 }, event: { service_time_cv: 2 } });
    expect(setVar(p, 'api', 'service_time_cv', undefined).nodes.find((n) => n.id === 'api')!.vars.normal).not.toHaveProperty('service_time_cv');
  });

  it('자동 배치: 연결 순서대로 열이 나뉘고 같은 열은 겹치지 않음', () => {
    const pos = autoLayout(base);
    expect(pos.web.x).toBe(0);
    expect(pos.lb.x).toBeGreaterThan(pos.web.x);
    expect(pos.api.x).toBeGreaterThan(pos.lb.x);
    const xy = Object.values(pos).map((v) => `${v.x},${v.y}`);
    expect(new Set(xy).size).toBe(xy.length);
  });
});
