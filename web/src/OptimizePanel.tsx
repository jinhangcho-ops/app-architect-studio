import { Select } from './Select';
import { useState } from 'react';
import type { OptimizeResult, Plan } from '../../engine/optimize';
import type { Project } from '../../engine/schema';
import { catalog } from './data';
import { applyPlan, findPlans } from './edit';
import { NumField, Section } from './fields';
import { fmt, fmtShare } from './format';
import { usePick } from './store';

const GOALS = [...new Set(catalog.items.flatMap((i) => Object.keys(i.goals)))].sort();

export function OptimizePanel({ today }: { today: string }) {
  const { project: p, edit } = usePick('project', 'edit');
  const [found, setFound] = useState<{ for: Project; result?: OptimizeResult; error?: string }>();
  const o = p.optimize;
  const setOpt = (patch: Partial<Project['optimize']>) => edit((x) => ({ ...x, optimize: { ...x.optimize, ...patch } }));
  const move = (i: number, d: -1 | 1) => {
    const next = [...o.priorities];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    setOpt({ priorities: next });
  };
  const stale = found && found.for !== p;
  const r = found?.result;

  return (
    <div className="panel">
      <Section title="목표 우선순위 (위가 더 중요)">
        {!o.priorities.length && <p className="muted">비우면 모든 목표를 같은 무게로 봅니다.</p>}
        {o.priorities.map((g, i) => (
          <div key={g} className="alt">
            {i + 1}. {g}
            <span className="spacer" />
            <button disabled={i === 0} onClick={() => move(i, -1)} aria-label="위로">↑</button>
            <button disabled={i === o.priorities.length - 1} onClick={() => move(i, 1)} aria-label="아래로">↓</button>
            <button onClick={() => setOpt({ priorities: o.priorities.filter((x) => x !== g) })} aria-label="빼기">×</button>
          </div>
        ))}
        <Select value="" onChange={(e) => e.target.value && setOpt({ priorities: [...o.priorities, e.target.value] })}>
          <option value="">+ 목표 추가</option>
          {GOALS.filter((g) => !o.priorities.includes(g)).map((g) => <option key={g} value={g}>{g}</option>)}
        </Select>
      </Section>

      <Section title="꼭 지킬 조건 (비우면 없음)">
        <NumField label="월 예산" value={o.budget_monthly} onChange={(v) => setOpt({ budget_monthly: v })} />
        <NumField label="목표 한계 사용자" value={o.min_limit_users} step={10000} onChange={(v) => setOpt({ min_limit_users: v })} />
        <NumField label="경로 p99 상한(ms)" value={o.max_p99_ms} onChange={(v) => setOpt({ max_p99_ms: v })} />
        <NumField label="가용성 하한" value={o.min_availability} step={0.0001} onChange={(v) => setOpt({ min_availability: v })} />
        <button className="primary" onClick={() => setFound({ for: p, ...findPlans(p, today) })}>조합 찾기</button>
        {stale && <p className="warn">입력이 바뀌었습니다. 다시 찾으세요.</p>}
        {found?.error && <pre className="warn">{found.error}</pre>}
      </Section>

      {r && <>
        {!r.best && (
          <Section title="조건을 모두 지키는 조합이 없습니다">
            <ul>{r.relax.map((x) => <li key={x}>{x}</li>)}</ul>
          </Section>
        )}
        {r.best && <Plans result={r} project={found!.for} onApply={(as) => edit((x) => applyPlan(x, as))} />}
        <Section title={`비용–한계 (조합 ${r.evaluated.length}개)`}><Scatter result={r} /></Section>
      </>}
    </div>
  );
}

function Plans({ result: r, project: p, onApply }: { result: OptimizeResult; project: Project; onApply: (as: Record<string, string>) => void }) {
  const cols: [string, Plan | undefined][] = [['지금', r.current], ['최선', r.best], ['최저 비용', r.cheapest], ['최대 확장', r.scalable]];
  const nodes = p.nodes.filter((n) => n.primary && r.current.assignment[n.id]);
  const metric = (x: Plan | undefined, f: (x: Plan) => string) => (x ? f(x) : '—');
  const same = (a?: Plan, b?: Plan) => a && b && JSON.stringify(a.assignment) === JSON.stringify(b.assignment);
  return (
    <Section title="추천 조합">
      {same(r.best, r.cheapest) && same(r.best, r.scalable) && <p className="muted">세 기준의 답이 같은 조합입니다.</p>}
      {same(r.best, r.current) && <p className="muted">지금 설계가 이미 최선입니다.</p>}
      <div className="plans">
        <table>
          <thead><tr><th />{cols.map(([l]) => <th key={l}>{l}</th>)}</tr></thead>
          <tbody>
            {nodes.map((n) => (
              <tr key={n.id}>
                <td>{n.name}</td>
                {cols.map(([l, x]) => {
                  const id = x?.assignment[n.id];
                  return <td key={l} className={id && id !== n.primary ? 'changed' : ''}>{id ? catalog.byId.get(id)?.name : '—'}</td>;
                })}
              </tr>
            ))}
            {([
              ['월 비용', (x: Plan) => (x.metrics.cost === undefined ? '가격 없음' : fmt(x.metrics.cost))],
              ['한계 사용자', (x: Plan) => (x.metrics.limitUsers === undefined ? '미확인' : `${fmt(x.metrics.limitUsers)}명`)],
              ['최대 p99', (x: Plan) => (x.metrics.p99 === undefined ? '—' : `${fmt(x.metrics.p99)}ms`)],
              ['최소 가용성', (x: Plan) => (x.metrics.availability === undefined ? '—' : fmtShare(x.metrics.availability))],
              ['우선순위 점수', (x: Plan) => String(x.score)],
            ] as const).map(([label, f]) => (
              <tr key={label} className="metric-row"><td>{label}</td>{cols.map(([l, x]) => <td key={l}>{metric(x, f)}</td>)}</tr>
            ))}
            <tr><td />{cols.map(([l, x]) => <td key={l}>{x && l !== '지금' && !same(x, r.current) && <button onClick={() => onApply(x.assignment)}>적용</button>}</td>)}</tr>
          </tbody>
        </table>
      </div>
      <p className="muted">바뀐 항목은 굵게 표시. 한계 '미확인'은 카탈로그 기준값이 없어 끝까지 판정이 넘어가지 않은 경우입니다.</p>
    </Section>
  );
}

/** 가로 = 월 비용, 세로 = 한계 사용자. 조건을 지킨 조합은 진하게, 어긴 조합은 흐리게 */
function Scatter({ result: r }: { result: OptimizeResult }) {
  const pts = r.evaluated.filter((x) => x.metrics.cost !== undefined && x.metrics.limitUsers !== undefined);
  if (!pts.length) return <p className="muted">비용과 한계를 둘 다 아는 조합이 없어 그래프를 그리지 않습니다.</p>;
  const W = 320, H = 180, P = 36;
  const xs = pts.map((x) => x.metrics.cost!), ys = pts.map((x) => x.metrics.limitUsers!);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)], [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  const sx = (v: number) => P + (x1 === x0 ? (W - 2 * P) / 2 : ((v - x0) / (x1 - x0)) * (W - 2 * P));
  const sy = (v: number) => H - P + (y1 === y0 ? -(H - 2 * P) / 2 : -((v - y0) / (y1 - y0)) * (H - 2 * P));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="scatter" role="img" aria-label="조합별 월 비용과 한계 사용자">
      <line x1={P} y1={H - P} x2={W - 8} y2={H - P} className="axis" />
      <line x1={P} y1={8} x2={P} y2={H - P} className="axis" />
      <text x={W - 8} y={H - 8} textAnchor="end">월 비용 {fmt(x0)}~{fmt(x1)}</text>
      <text x={4} y={14}>한계 {fmt(y1)}명</text>
      {pts.map((x, i) => (
        <circle key={i} cx={sx(x.metrics.cost!)} cy={sy(x.metrics.limitUsers!)} r={x === r.best ? 6 : 4}
          className={x === r.best ? 'pt best' : x.violations.length ? 'pt bad' : 'pt'}>
          <title>{`비용 ${fmt(x.metrics.cost!)} · 한계 ${fmt(x.metrics.limitUsers!)}명${x.violations.length ? ` · 어김: ${x.violations.join(', ')}` : ''}`}</title>
        </circle>
      ))}
    </svg>
  );
}
