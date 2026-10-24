// 14절 유입 모형: 사용자가 어떤 경로로 들어와(바깥 유입·입소문, Bass 확산) 어떤 페르소나 단계를 거치는지 달마다 계산한다.
// 새 사용자는 정해진 페르소나로 들어오고, 달마다 일부는 한 단계 더 활발한 페르소나로, 일부는 덜 활발한 페르소나로 옮기며, 가장 덜 활발한 단계에서 일부가 떠난다.
// 페르소나마다 1인당 요청이 달라서, 부하는 사람 수가 아니라 "지금 사용 패턴으로 환산한 사용자 수"(equivalent)로 늘어난다.
import { PATTERN_IDS, type Project } from './schema';
import { patternOf, perSession } from './traffic';

export type AdoptionMonth = {
  month: number;
  /** 이번 달 새로 들어온 사람: 바깥 유입(광고·검색), 입소문 */
  external: number;
  wordOfMouth: number;
  /** 페르소나별 활성 사용자 (p.personas 순서) */
  byPersona: number[];
  active: number;
  /** 지금까지 떠난 사람 */
  left: number;
  /** 페르소나별 1인당 요청을 반영해 지금 사용 패턴으로 환산한 사용자 수. 부하·비용·한계 시점은 이 값으로 늘어난다 */
  equivalent: number;
};

/** 유입 모형이 없거나 규모가 없으면 undefined. months달까지 (0달 = 지금) */
export function adoption(p: Project, months: number): AdoptionMonth[] | undefined {
  const f = p.growth?.inflow;
  if (!f || !p.scale || !p.personas.length) return undefined;
  const users = p.scale.users;
  // 1인당 하루 요청 (기댓값). 환산 사용자 = Σ 사람 × 1인당 요청 / 지금 평균 1인당 요청
  const perPerson = p.personas.map((ps) => patternOf(ps).sessions_per_day * perSession(p, ps).reqPer);
  const avg = p.personas.reduce((s, ps, i) => s + ps.share * perPerson[i], 0) || 1;
  const equivalentOf = (counts: number[]) => counts.reduce((s, c, i) => s + (c * perPerson[i]) / avg, 0);
  // 단계 순서: 사용 패턴이 활발한 것부터 (같은 패턴이면 입력 순서)
  const order = p.personas.map((_, i) => i).sort((a, b) => PATTERN_IDS.indexOf(p.personas[a].pattern) - PATTERN_IDS.indexOf(p.personas[b].pattern) || a - b);
  const entry = p.personas.findIndex((ps) => ps.name === f.entry);

  let counts = p.personas.map((ps) => users * ps.share);
  let adopted = users, left = 0;
  const out: AdoptionMonth[] = [{ month: 0, external: 0, wordOfMouth: 0, byPersona: counts, active: users, left: 0, equivalent: equivalentOf(counts) }];
  for (let mo = 1; mo <= months; mo++) {
    const rest = Math.max(0, f.market - adopted);
    const external = f.external * rest;
    const wordOfMouth = Math.min(rest - external, f.word_of_mouth * (adopted / f.market) * rest);
    adopted += external + wordOfMouth;
    const next = [...counts];
    next[entry] += external + wordOfMouth;
    // 단계 옮기기 (지난달 사람 기준으로 한꺼번에)
    order.forEach((i, k) => {
      const up = k > 0 ? f.up * counts[i] : 0;
      const last = k === order.length - 1;
      const down = last ? 0 : f.down * counts[i];
      const gone = last ? f.leave * counts[i] : 0;
      next[i] -= up + down + gone;
      if (k > 0) next[order[k - 1]] += up;
      if (!last) next[order[k + 1]] += down;
      left += gone;
    });
    counts = next.map((c) => Math.max(0, c));
    out.push({ month: mo, external, wordOfMouth, byPersona: counts, active: counts.reduce((s, c) => s + c, 0), left, equivalent: equivalentOf(counts) });
  }
  return out;
}

/** 환산 사용자가 한계에 처음 닿는 달. 끝까지 안 닿으면 undefined */
export const monthReaching = (curve: AdoptionMonth[], limitUsers: number) => curve.find((m) => m.equivalent >= limitUsers)?.month;
