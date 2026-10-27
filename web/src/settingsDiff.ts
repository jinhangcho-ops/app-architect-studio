// 설정 화면의 칸과 그 칸이 다루는 값. 불러온 프로젝트(baseline)와 비교해 바뀐 항목 수를 세고, 한 번에 되돌린다.
import type { Project } from '../../engine/schema';
import { keepWrites } from './edit';

const flat = (o: object | undefined, pre = ''): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [pre + k, v]));
const each = (xs: unknown[], pre: string): Record<string, unknown> => Object.fromEntries(xs.map((x, i) => [`${pre}${i}`, x]));

export const SETTINGS: { id: string; title: string; fields: (p: Project) => Record<string, unknown> }[] = [
  { id: 's-proj', title: '프로젝트', fields: (p) => ({ name: p.name }) },
  // 설계 메모는 설정 값이 아니라 글이라 "불러온 값으로 되돌리기"가 지우지 않게 세지 않는다
  { id: 's-notes', title: '설계 메모', fields: () => ({}) },
  { id: 's-mode', title: '구동 방식', fields: (p) => flat(p.deploy) },
  { id: 's-scale', title: '규모', fields: (p) => {
    const { industry: _i, day: _d, spikes: _s, ...rest } = p.scale ?? {};
    return { ...flat(rest), has: !!p.scale, target_utilization: p.target_utilization };
  } },
  { id: 's-peak', title: '하루 피크', fields: (p) => ({ industry: p.scale?.industry, day: p.scale?.day, spikes: p.scale?.spikes }) },
  { id: 's-pers', title: '페르소나', fields: (p) => ({ ...each(p.personas, 'p'), n: p.personas.length, mix: p.persona_mix }) },
  { id: 's-act', title: '행동', fields: (p) => ({ ...each(p.actions, 'a'), n: p.actions.length }) },
  { id: 's-ex', title: '데이터 주고받기', fields: (p) => ({ ...flat(p.exchange), has: !!p.exchange }) },
  { id: 's-growth', title: '성장', fields: (p) => ({ ...flat(p.growth), ...flat(p.growth?.inflow, 'in.'), has: !!p.growth }) },
  { id: 's-cost', title: '비용 기준', fields: (p) => flat(p.cost) },
  { id: 's-rec', title: '장애 목표', fields: (p) => ({ ...flat(p.recovery), has: !!p.recovery }) },
  // 이 PC의 앱 설정이라 프로젝트의 바뀐 항목으로 세지 않는다
  { id: 's-app', title: '앱', fields: () => ({}) },
];

/** 칸마다 불러온 값과 다른 항목 수 */
export function changedCounts(now: Project, base: Project): Record<string, number> {
  return Object.fromEntries(SETTINGS.map((s) => {
    const a = s.fields(now), b = s.fields(base);
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [s.id, [...keys].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).length];
  }));
}

/** 설정 화면이 다루는 값만 불러온 때로 되돌린다 (노드·연결선·위치는 그대로).
 *  되돌린 행동의 쓰기 줄은 지금 있는 노드·테이블로 거른다 (그 사이 지우거나 이름을 바꿨을 수 있어서) */
export const resetSettings = (now: Project, base: Project): Project => {
  const tables = new Set(now.nodes.flatMap((n) => n.tables.map((t) => `${n.id}\u0000${t.name}`)));
  return keepWrites({
    ...now,
    name: base.name, deploy: base.deploy, scale: base.scale, target_utilization: base.target_utilization,
    personas: base.personas, persona_mix: base.persona_mix, actions: base.actions, exchange: base.exchange, growth: base.growth, cost: base.cost, recovery: base.recovery,
  }, (w) => tables.has(`${w.node}\u0000${w.table}`));
};
