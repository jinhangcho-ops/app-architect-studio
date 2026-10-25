// 설정 화면의 "하루 피크(업종)"와 "페르소나 분포": 업종 미리 설정을 누르면 둘이 한 번에 바뀌고, 봉우리를 끌어서 고칠 수 있다.
import { INDUSTRIES, INDUSTRY_IDS, mixShares } from '../../engine/industry';
import { applyIndustry, setPersonaMix, updatePersona } from './edit';
import { NumField, Row, Section } from './fields';
import { PeakEditor } from './PeakEditor';
import { Select } from './Select';
import { usePick } from './store';

/** 페르소나 칸 색 (시안의 7색, 더 많으면 돌려 쓴다) */
const PC = ['#5B8DEF', '#14B8A6', '#F5A524', '#8B5CF6', '#E879B9', '#94A3B8', '#64748B'];
const HOURS = [0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) => ({ at: h, label: `${h}시` }));
// 저장 파일이 길어지지 않게 자리수를 줄인다 (비중은 0이 되면 스키마가 막으므로 아주 작은 값으로)
const r = (x: number, d = 1000) => Math.round(x * d) / d;
const pos = (x: number) => Math.max(0.001, r(x));
/** 10분 단위 시각: 18.5 → "18시 30분" */
const hhmm = (h: number) => {
  const m = Math.round(h * 6) * 10, hh = Math.floor(m / 60) % 24, mm = m % 60;
  return `${hh}시${mm ? ` ${mm}분` : ''}`;
};

export function DayPeakSection() {
  const { project: p, edit } = usePick('project', 'edit');
  const sc = p.scale;
  const preset = sc?.industry ? INDUSTRIES[sc.industry] : undefined;
  const shape = sc?.day ?? preset;
  type Day = NonNullable<NonNullable<typeof sc>['day']>;
  const setDay = (day: Day) => edit((x) => (x.scale ? { ...x, scale: { ...x.scale, day } } : x));
  const custom = !!sc?.day;
  return (
    <Section id="s-peak" title="하루 피크 (업종)" desc="몇 시에 사용자가 몰리는지예요. 업종을 고르면 피크 시각과 페르소나 분포가 한 번에 바뀌고, 봉우리를 끌어서 고칠 수 있어요.">
      {!sc && <p className="muted">먼저 규모를 입력해 주세요.</p>}
      {sc && <>
        <div className="presets" role="group" aria-label="업종 미리 설정">
          {INDUSTRY_IDS.map((id) => (
            <button key={id} className="chip" aria-pressed={sc.industry === id && !custom} onClick={() => edit((x) => applyIndustry(x, id))}>{INDUSTRIES[id].label}</button>
          ))}
          <button className="chip" aria-pressed={!sc.industry && !custom} onClick={() => edit((x) => applyIndustry(x, undefined))}>없음</button>
        </div>
        {preset && <p className="muted">{preset.why} {preset.mixWhy} (예시값){custom && ' · 지금은 이 업종에서 직접 조정한 모양이에요. 업종을 다시 누르면 처음 모양으로 돌아가요.'}</p>}
        {!shape && <>
          <p className="muted">업종이 없으면 페르소나마다 깨어 있는 시간 가운데에 한 번 몰려요.</p>
          <div className="inline"><button onClick={() => setDay({ window: [8, 23], peaks: [{ at: 20, sd: 2, weight: 1 }] })}>직접 정하기</button></div>
        </>}
        {shape && <>
          <PeakEditor domain={24} wrap sgMin={0.3} sgMax={6} ticks={HOURS} band={shape.window}
            peaks={shape.peaks.map((k) => ({ mu: k.at, sg: k.sd, w: k.weight }))}
            onChange={(ps) => setDay({ window: shape.window, peaks: ps.map((k) => ({ at: r(k.mu, 100), sd: r(k.sg, 100), weight: pos(k.w) })) })}
            peakName={(k) => hhmm(k.mu)} width={(sg) => `±${sg.toFixed(1)}시간`} />
          <NumField label="깨어 있는 시간 시작(시)" hint="칠해진 구간이에요. 이 구간 안에 들어오는 접속 몫이 '창 안 비율'이에요" value={shape.window[0]} step={1}
            onChange={(v) => v !== undefined && v >= 0 && v <= 24 && setDay({ window: [v, shape.window[1]], peaks: shape.peaks })} />
          <NumField label="깨어 있는 시간 끝(시)" hint="시작보다 작으면 자정을 넘어요 (예: 11~2시)" value={shape.window[1]} step={1}
            onChange={(v) => v !== undefined && v >= 0 && v <= 24 && setDay({ window: [shape.window[0], v], peaks: shape.peaks })} />
        </>}
      </>}
    </Section>
  );
}

export function PersonaMixEditor() {
  const { project: p, edit } = usePick('project', 'edit');
  const n = p.personas.length;
  if (!n) return null;
  const binOf = (mu: number) => Math.min(n - 1, Math.max(0, Math.floor(mu * n)));
  return <>
    {!p.persona_mix && <p className="muted">지금 비율은 직접 넣은 값이에요. 봉우리를 움직이면 분포대로 비율을 다시 정해요.</p>}
    <PeakEditor domain={1} sgMin={0.04} sgMax={0.5}
      peaks={p.persona_mix ?? [{ mu: 0.4, sg: 0.2, w: 1 }]}
      bins={p.personas.map((ps, i) => ({ label: ps.name, color: PC[i % PC.length] }))}
      binValues={(ps, dragging) => (dragging || p.persona_mix ? mixShares(ps, n) : p.personas.map((x) => Math.round(x.share * 100))).map((x) => `${x}%`)}
      onChange={(ps) => edit((x) => setPersonaMix(x, ps.map((k) => ({ mu: r(k.mu), sg: r(k.sg), w: pos(k.w) }))))}
      peakName={(k) => p.personas[binOf(k.mu)].name} width={(sg) => `${(sg * n).toFixed(1)}칸`}>
      {(k, setMu) => {
        const i = binOf(k.mu);
        return <>
          <Row label="피크가 가리키는 페르소나" hint="고르면 선택한 피크가 그 칸 가운데로 가요">
            <Select value={String(i)} onChange={(e) => setMu((Number(e.target.value) + 0.5) / n)}>
              {p.personas.map((ps, j) => <option key={j} value={j}>{j + 1}. {ps.name}</option>)}
            </Select>
          </Row>
          <Row label="이름 바꾸기" hint="위에서 고른 페르소나의 이름이에요">
            <input value={p.personas[i].name} maxLength={20} onChange={(e) => edit((x) => updatePersona(x, i, { name: e.target.value }))} />
          </Row>
          <Row label="이 페르소나 비율" hint="모든 페르소나 비율의 합은 늘 100%예요"><b className="share" style={{ color: PC[i % PC.length] }}>{Math.round(p.personas[i].share * 100)}%</b></Row>
        </>;
      }}
    </PeakEditor>
  </>;
}
