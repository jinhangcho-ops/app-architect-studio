import { useState } from 'react';
import type { Analysis } from '../../engine/analyze';
import { judgeItem } from '../../engine/judge';
import { LAYERS, LAYER_NAMES, VERDICT_NAMES, type Layer } from '../../engine/model';
import { catalog, prices } from './data';
import { applyAlternative, removeEdge, removeNode, setVar, updateEdge, updateNode } from './edit';
import { NumField, Row, Section, TextField } from './fields';
import { fmtMetric, howMetric } from './format';
import { useStore } from './store';

const itemName = (id: string) => catalog.byId.get(id)?.name ?? id;

/** 입력 칸의 글자를 판정 변수 값으로: 숫자·참거짓·그 밖의 글자 */
const parseValue = (s: string) => (s === 'true' ? true : s === 'false' ? false : s !== '' && !Number.isNaN(Number(s)) ? Number(s) : s);

export function NodePanel({ id, analysis }: { id: string; analysis?: Analysis }) {
  const { project, edit, select } = useStore();
  const [goal, setGoal] = useState('');
  const [newVar, setNewVar] = useState('');
  const n = project.nodes.find((x) => x.id === id);
  if (!n) return <p className="muted">노드가 없습니다.</p>;

  const upd = (patch: Parameters<typeof updateNode>[2]) => edit((p) => updateNode(p, id, patch));
  const j = analysis?.judgements.find((x) => x.nodeId === id);
  const na = analysis?.nodes[id];
  const scenario = analysis?.scenarios[id];
  const fits = catalog.items.filter((i) => i.attaches_to.includes(n.layer));
  const goals = [...new Set(fits.flatMap((i) => Object.keys(i.goals)))].sort();
  // 판단 불가 이유에서 빠진 변수 이름을 뽑아 바로 입력할 수 있게 한다
  const missing = [...new Set(j?.items.flatMap((i) => i.verdict === 'unknown' ? i.reasons[0].split(': ')[1]?.split(', ') ?? [] : []) ?? [])]
    .filter((k) => !k.startsWith('th.'));

  const changeLayer = (layer: Layer) => upd({
    layer,
    primary: n.primary && catalog.byId.get(n.primary)?.attaches_to.includes(layer) ? n.primary : undefined,
    extras: n.extras.filter((x) => catalog.byId.get(x)?.attaches_to.includes(layer)),
  });

  return (
    <div className="panel">
      <Section title="기본">
        <TextField label="이름" value={n.name} onChange={(v) => upd({ name: v })} />
        <Row label="레이어">
          <select value={n.layer} onChange={(e) => changeLayer(e.target.value as Layer)}>
            {LAYERS.map((l) => <option key={l} value={l}>{LAYER_NAMES[l]}</option>)}
          </select>
        </Row>
        <Row label="설명"><textarea value={n.description ?? ''} onChange={(e) => upd({ description: e.target.value || undefined })} /></Row>
      </Section>

      <Section title="선택 항목">
        <Row label="주 항목">
          <select value={n.primary ?? ''} onChange={(e) => upd({ primary: e.target.value || undefined })}>
            <option value="">(없음)</option>
            {fits.filter((i) => i.role === '주').map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
        </Row>
        <div className="checks">
          {fits.filter((i) => i.role === '보조').map((i) => (
            <label key={i.id} title={i.summary}>
              <input type="checkbox" checked={n.extras.includes(i.id)}
                onChange={(e) => upd({ extras: e.target.checked ? [...n.extras, i.id] : n.extras.filter((x) => x !== i.id) })} />
              {i.name}
            </label>
          ))}
        </div>
      </Section>

      <Section title="★ 판정 근거">
        {!j?.items.length && <p className="muted">항목을 고르면 판정합니다.</p>}
        {j?.items.map((it) => (
          <div key={it.itemId} className={`judge v-${it.verdict}`}>
            <div><b>{VERDICT_NAMES[it.verdict]}</b> {itemName(it.itemId)}</div>
            <div className="summary">{catalog.byId.get(it.itemId)?.summary}</div>
            <ul>{it.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
            {it.alternatives.map((a) => (
              <div key={a.id} className="alt">
                → {VERDICT_NAMES[a.verdict]} {itemName(a.id)}{a.note ? ` (${a.note})` : ''}
                <button onClick={() => edit((p) => applyAlternative(p, id, it.itemId, a.id))}>적용</button>
              </div>
            ))}
          </div>
        ))}
      </Section>

      <Section title="📊 계산 결과">
        <table className="metrics"><tbody>
          {([
            ['피크 RPS (평소)', na?.load && { value: na.load.rps.normal, unit: 'RPS', formula: '연결선을 따라 내려온 부하', inputs: {} }],
            ['피크 RPS (이벤트)', na?.load && { value: na.load.rps.event, unit: 'RPS', formula: '연결선을 따라 내려온 부하', inputs: {} }],
            ['대당 처리량', na?.perInstanceRps],
            ['필요 대수 (이벤트)', na?.instances?.event],
            ['사용률 (이벤트)', na?.utilization?.event],
            ['p99 (이벤트)', na?.p99?.event],
            ['가용성', na?.availability],
            ['한계 사용자', na?.limitUsers],
          ] as const).map(([label, m]) => (
            <tr key={label} title={howMetric(m || undefined)}><td>{label}</td><td>{fmtMetric(m || undefined)}</td></tr>
          ))}
        </tbody></table>
      </Section>

      <Section title="목표로 찾기">
        <select value={goal} onChange={(e) => setGoal(e.target.value)}>
          <option value="">목표 고르기</option>
          {goals.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
        {goal && fits.filter((i) => i.goals[goal] === '좋음').map((i) => {
          const v = scenario && judgeItem(i, n, scenario).verdict;
          const has = n.primary === i.id || n.extras.includes(i.id);
          return (
            <div key={i.id} className="alt" title={i.summary}>
              {v && VERDICT_NAMES[v]} {i.name} <span className="muted">({i.role})</span>
              {!has && <button onClick={() => upd(i.role === '주' ? { primary: i.id } : { extras: [...n.extras, i.id] })}>적용</button>}
            </div>
          );
        })}
      </Section>

      <Section title="사양·운영">
        <NumField label="vCPU" value={n.spec?.vcpu} onChange={(v) => upd({ spec: { ...n.spec, vcpu: v } })} />
        <NumField label="메모리(GB)" value={n.spec?.memGb} onChange={(v) => upd({ spec: { ...n.spec, memGb: v } })} />
        <NumField label="이중화 대수" value={n.replicas} step={1} onChange={(v) => upd({ replicas: v ?? 1 })} />
        <NumField label="최소 대수" value={n.min_instances} step={1} onChange={(v) => upd({ min_instances: v ?? 1 })} />
        <NumField label="1대 가용성" value={n.availability} step={0.0001} hint="비우면 프로젝트 기본값" onChange={(v) => upd({ availability: v })} />
        <NumField label="평균 처리(ms)" value={n.perf?.service_ms} onChange={(v) => upd({ perf: v ? { workers: n.perf?.workers ?? 8, ...n.perf, service_ms: v } : undefined })} />
        <NumField label="대당 동시 처리" value={n.perf?.workers} step={1} onChange={(v) => n.perf && upd({ perf: { ...n.perf, workers: v ?? 1 } })} />
        <Row label="가격 상품">
          <select value={n.price ?? ''} onChange={(e) => upd({ price: e.target.value || undefined })}>
            <option value="">(없음)</option>
            {prices.filter((r) => r.unit === 'hour' || r.unit === 'month').map((r) => <option key={r.id} value={r.id}>{r.id}</option>)}
          </select>
        </Row>
      </Section>

      <Section title="직접 넣는 값">
        {[...new Set([...Object.keys(n.vars.normal), ...missing])].map((k) => (
          <Row key={k} label={k} hint="평소와 이벤트에 같은 값으로 들어갑니다. 비우면 지웁니다">
            <input value={n.vars.normal[k] === undefined ? '' : String(n.vars.normal[k])}
              placeholder="값 없음"
              onChange={(e) => edit((p) => setVar(p, id, k, e.target.value === '' ? undefined : parseValue(e.target.value)))} />
          </Row>
        ))}
        <div className="inline">
          <input placeholder="변수 이름" value={newVar} onChange={(e) => setNewVar(e.target.value)} />
          <button onClick={() => { if (newVar) edit((p) => setVar(p, id, newVar, 0)); setNewVar(''); }}>추가</button>
        </div>
      </Section>

      <button className="danger" onClick={() => { edit((p) => removeNode(p, id)); select(null); }}>노드 삭제</button>
    </div>
  );
}

export function EdgePanel({ from, to }: { from: string; to: string }) {
  const { project, edit, select } = useStore();
  const e = project.edges.find((x) => x.from === from && x.to === to);
  if (!e) return <p className="muted">연결선이 없습니다.</p>;
  const name = (id: string) => project.nodes.find((n) => n.id === id)?.name ?? id;
  const upd = (patch: Parameters<typeof updateEdge>[3]) => edit((p) => updateEdge(p, from, to, patch));
  return (
    <div className="panel">
      <Section title={`${name(from)} → ${name(to)}`}>
        <Row label="동기 호출"><input type="checkbox" checked={e.sync} onChange={(x) => upd({ sync: x.target.checked })} /></Row>
        <NumField label="호출 비율" value={e.callRatio} hint="요청 1건당 이 연결로 몇 번 부르는지" onChange={(v) => upd({ callRatio: v ?? 1 })} />
        <Row label="흐르는 요청">
          <select value={e.carries} onChange={(x) => upd({ carries: x.target.value as typeof e.carries })}>
            <option value="all">전체</option><option value="read">읽기만</option><option value="write">쓰기만</option>
          </select>
        </Row>
        <NumField label="왕복 지연(ms)" value={e.rtt_ms} onChange={(v) => upd({ rtt_ms: v ?? 0 })} />
      </Section>
      <button className="danger" onClick={() => { edit((p) => removeEdge(p, from, to)); select(null); }}>연결선 삭제</button>
    </div>
  );
}
