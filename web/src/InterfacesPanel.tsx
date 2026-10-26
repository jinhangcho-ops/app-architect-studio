// 연결선의 인터페이스 명세: 보내는 노드가 받는 노드에 부르는 REST·gRPC 호출과 큐 메시지. 호출 수는 부하 계산에, 크기는 리전 간 전송량에 쓰인다
import type { Analysis } from '../../engine/analyze';
import { GAP_EFFECT, interfaceRates, isWrite, layoutRows, oneWay, recordBytes, requestBytes, responseBytes, specGaps } from '../../engine/interfaces';
import { readMiss } from '../../engine/load';
import { FIELD_TYPES, HTTP_METHODS, IDENT, type Interface, type Project, type ProjectEdge, type SpecField } from '../../engine/schema';
import { updateEdge } from './edit';
import { NumField, NumInput, Row, Section, TextField } from './fields';
import { fmt } from './format';
import { Select } from './Select';
import { usePick } from './store';

const KIND_NAMES = { rest: 'REST (HTTP)', grpc: 'gRPC', message: '메시지 (큐·이벤트)', file: '파일·전문' } as const;
const PATH_LABEL = { rest: '경로', grpc: '메서드 이름', message: '토픽', file: '파일·전문 ID' } as const;
const PATH_HINT = { rest: '/로 시작. 경로 변수는 {order_id}처럼', grpc: '영문 식별자 (예: CreateOrder)', message: '큐의 토픽·채널 이름 (예: orders.created)', file: '파일 이름 규칙이나 전문 ID (예: SALES_YYYYMMDD.dat, TR0101)' } as const;
const DELIMITERS: Record<string, string> = { ',': '쉼표 (,)', '|': '파이프 (|)', ';': '세미콜론 (;)', '\t': '탭' };
const DEFAULT_RECORD = { format: 'fixed', delimiter: ',', encoding: 'utf-8', newline: 'crlf', header: false } as const;
const FIELD_NAMES: Record<(typeof FIELD_TYPES)[number], string> = {
  string: '문자열', integer: '정수', number: '실수', boolean: '참·거짓', datetime: '날짜·시각', uuid: 'UUID', object: '객체', array: '배열',
};

export function InterfacesSection({ e, analysis }: { e: ProjectEdge; analysis?: Analysis }) {
  const { project, edit } = usePick('project', 'edit');
  const toLayer = project.nodes.find((n) => n.id === e.to)?.layer;
  const set = (interfaces: Interface[]) => edit((p) => updateEdge(p, e.from, e.to, { interfaces }));
  const upd = (k: number, patch: Partial<Interface>) => set(e.interfaces.map((x, j) => (j === k ? { ...x, ...patch } : x)));
  const add = () => {
    let n = e.interfaces.length + 1;
    while (e.interfaces.some((x) => x.name === `인터페이스 ${n}`)) n++;
    const base = { name: `인터페이스 ${n}`, per_request: 1, on: 'all' as const, request: [], response: [], errors: [] };
    set([...e.interfaces, toLayer === 'queue' ? { ...base, kind: 'message', path: 'topic.name' } : { ...base, kind: 'rest', method: 'GET', path: '/path' }]);
  };
  // 이 연결로 가는 인터페이스별 초당 호출 (평소 / 이벤트)
  const from = analysis?.nodes[e.from]?.load;
  const rates = from && e.interfaces.length ? { normal: interfaceRates(e, from, 'normal', readMiss(project, e)), event: interfaceRates(e, from, 'event', readMiss(project, e)) } : undefined;

  return (
    <Section title={`인터페이스 명세 (${e.interfaces.length})`} desc="이 연결로 주고받는 호출·메시지예요. 적으면 호출 수로 부하를, 크기로 리전 간 전송량을 계산하고, 파일 › 인터페이스 명세 내보내기로 OpenAPI·AsyncAPI·proto, 파일·전문 레이아웃(CSV), 받는 쪽이 FastAPI면 엔드포인트 뼈대를 만들어요.">
      {e.interfaces.map((x, k) => (
        <details key={k} className="table-editor">
          <summary>
            <b>{x.name}</b> <span className="muted">{x.kind === 'rest' ? `${x.method ?? 'GET'} ${x.path}` : `${KIND_NAMES[x.kind]} ${x.path}`}
              {x.kind === 'file' && x.record && ` · ${x.record.format === 'fixed' ? '고정장' : '가변장'}`}
              {rates && ` · ${fmt(rates.normal[k].rps)} / ${fmt(rates.event[k].rps)} RPS`} · {x.kind === 'file' ? '레코드' : '요청'} {fmt(requestBytes(x))}B{!oneWay(x) && ` / 응답 ${fmt(responseBytes(x))}B`}</span>
            {specGaps(x).length > 0 && <span className="warn"> ⚠️ 빠진 것 {specGaps(x).length}</span>}
          </summary>
          <TextField label="이름" value={x.name} onChange={(v) => upd(k, { name: v })} />
          <Row label="방식">
            <Select value={x.kind} onChange={(ev) => {
              const kind = ev.target.value as Interface['kind'];
              // 파일·전문은 바이트 길이만 쓰고 인증·에러 응답이 없다. 다른 방식이면 길이를 지운다
              const file = kind === 'file';
              // 경로가 새 방식 모양과 다르면 기본값으로 (gRPC "/path"·REST "topic.name"은 명세로 내보낼 수 없다)
              const path = kind === 'rest' ? (x.path.startsWith('/') ? x.path : `/${x.path || 'path'}`)
                : kind === 'grpc' ? (IDENT.test(x.path) ? x.path : 'Method1')
                : kind === 'message' && x.path.startsWith('/') ? 'topic.name' : x.path;
              upd(k, {
                path,
                kind, method: kind === 'rest' ? x.method ?? 'GET' : undefined, ...(oneWay({ kind }) && { response: [] }), record: file ? x.record ?? { ...DEFAULT_RECORD } : undefined,
                ...(file ? { auth: undefined, errors: [], path: x.path.startsWith('/') ? 'FILE_ID' : x.path } : { request: x.request.map(({ length: _, ...f }) => f) }),
              });
            }}>
              {Object.entries(KIND_NAMES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </Row>
          {x.kind === 'rest' && <Row label="메서드">
            <Select value={x.method ?? 'GET'} onChange={(ev) => upd(k, { method: ev.target.value as Interface['method'] })}>
              {HTTP_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
            </Select>
          </Row>}
          <Row label={PATH_LABEL[x.kind]} hint={PATH_HINT[x.kind]}><input value={x.path} onChange={(ev) => upd(k, { path: ev.target.value })} /></Row>
          {x.kind === 'file' && <RecordFields i={x} onChange={(record) => upd(k, { record })} />}
          <Row label="부르는 요청" hint="보내는 노드가 받는 요청 중 어떤 것에서 부르나요">
            <Select value={x.on} onChange={(ev) => upd(k, { on: ev.target.value as Interface['on'] })}>
              <option value="all">모든 요청</option><option value="read">읽기 요청만</option><option value="write">쓰기 요청만</option>
            </Select>
          </Row>
          <NumField label="요청 1건당 횟수" value={x.per_request} step={0.1} hint="그 요청 1건마다 이 인터페이스를 몇 번 부르는지. 받는 노드의 부하 = 요청 × 이 값" onChange={(v) => upd(k, { per_request: v === undefined || v < 0 ? 1 : v })} />
          <Row label="받는 쪽에서" hint="받는 노드에 읽기로 보나 쓰기로 보나. 자동: REST는 GET만 읽기, 메시지·파일·전문은 쓰기, gRPC는 읽기">
            <Select value={x.op ?? ''} onChange={(ev) => upd(k, { op: (ev.target.value || undefined) as Interface['op'] })}>
              <option value="">자동</option><option value="read">읽기</option><option value="write">쓰기</option>
            </Select>
          </Row>
          {specGaps(x).length > 0 && <div className="warn">{specGaps(x).map((g) => <div key={g}>⚠️ {g}</div>)}<div className="muted">{GAP_EFFECT}</div></div>}
          {!oneWay(x) && <Row label="인증" hint="받는 쪽이 누가 부르는지 확인하는 방법. 정하지 않으면 명세 점검이 알려요">
            <Select value={x.auth ?? ''} onChange={(ev) => upd(k, { auth: (ev.target.value || undefined) as Interface['auth'] })}>
              <option value="">(미정)</option><option value="none">없음</option>
              <option value="bearer">Bearer 토큰 (Authorization 헤더, JWT 등)</option><option value="api_key">API 키 (X-API-Key 헤더)</option>
            </Select>
          </Row>}
          <TextField label="설명" value={x.description} onChange={(v) => upd(k, { description: v || undefined })} />
          <Fields title={x.kind === 'file' ? '레코드 필드 (순서대로)' : '요청 필드'} fields={x.request} fixed={x.kind === 'file' && x.record?.format === 'fixed'} onChange={(request) => upd(k, { request })} />
          {!oneWay(x) && <Fields title="응답 필드" fields={x.response} onChange={(response) => upd(k, { response })} />}
          <NumField label="요청 크기(B, 실측)" value={x.request_bytes} hint="비우면 필드 형식별 예시 크기로 어림해요" onChange={(v) => upd(k, { request_bytes: v === undefined || v < 0 ? undefined : v })} />
          {!oneWay(x) && <Errors errors={x.errors} onChange={(errors) => upd(k, { errors })} />}
          <TableLinks i={x} project={project} onChange={(tables) => upd(k, { tables: tables.length ? tables : undefined })} />
          {!oneWay(x) && <NumField label="응답 크기(B, 실측)" value={x.response_bytes} hint="비우면 필드 형식별 예시 크기로 어림해요" onChange={(v) => upd(k, { response_bytes: v === undefined || v < 0 ? undefined : v })} />}
          <button className="danger" onClick={() => set(e.interfaces.filter((_, j) => j !== k))}>이 인터페이스 삭제</button>
        </details>
      ))}
      <button onClick={add}>+ 인터페이스</button>
    </Section>
  );
}

/** 파일·전문의 장 형식: 고정장(필드마다 바이트 길이) · 가변장(구분자), 인코딩, 줄바꿈 */
function RecordFields({ i, onChange }: { i: Interface; onChange: (r: NonNullable<Interface['record']>) => void }) {
  const r = i.record ?? { ...DEFAULT_RECORD };
  const set = (patch: Partial<NonNullable<Interface['record']>>) => onChange({ ...r, ...patch });
  const len = recordBytes(i);
  return <>
    <Row label="장 형식" hint="고정장: 필드마다 바이트 길이가 정해져 위치로 읽음(숫자는 앞을 0, 문자는 뒤를 공백으로 채움). 가변장: 구분자로 나눔">
      <Select value={r.format} onChange={(ev) => set({ format: ev.target.value as 'fixed' | 'delimited' })}>
        <option value="fixed">고정장</option><option value="delimited">가변장 (구분자)</option>
      </Select>
    </Row>
    {r.format === 'delimited' && <>
      <Row label="구분자">
        <Select value={r.delimiter} onChange={(ev) => set({ delimiter: ev.target.value })}>
          {!Object.hasOwn(DELIMITERS, r.delimiter) && <option value={r.delimiter}>{r.delimiter}</option>}
          {Object.entries(DELIMITERS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </Select>
      </Row>
      <Row label="머리줄" hint="첫 줄에 필드 이름이 있는지"><input type="checkbox" checked={r.header} onChange={(ev) => set({ header: ev.target.checked })} /></Row>
    </>}
    <Row label="인코딩" hint="EUC-KR이면 한글 한 글자가 2바이트, UTF-8이면 3바이트">
      <Select value={r.encoding} onChange={(ev) => set({ encoding: ev.target.value as 'utf-8' | 'euc-kr' })}>
        <option value="utf-8">UTF-8</option><option value="euc-kr">EUC-KR</option>
      </Select>
    </Row>
    <Row label="줄바꿈">
      <Select value={r.newline} onChange={(ev) => set({ newline: ev.target.value as 'crlf' | 'lf' | 'none' })}>
        <option value="crlf">CRLF (Windows)</option><option value="lf">LF</option><option value="none">없음 (전문)</option>
      </Select>
    </Row>
    <p className="muted">레코드 길이: {len === undefined ? '필드 길이를 모두 넣으면 계산해요' : `${fmt(len)}바이트${r.format === 'delimited' ? ' (평균)' : ''}`}</p>
    {r.format === 'fixed' && len !== undefined && <p className="muted">위치: {layoutRows(i).map((x) => `${x.field.name} ${x.start}–${x.end}`).join(' · ')}</p>}
  </>;
}

function Fields({ title, fields, onChange, fixed }: { title: string; fields: SpecField[]; onChange: (f: SpecField[]) => void; fixed?: boolean }) {
  const upd = (k: number, patch: Partial<SpecField>) => onChange(fields.map((f, j) => (j === k ? { ...f, ...patch } : f)));
  return (
    <div>
      <p className="muted">{title} — 이름은 영문 식별자 (코드 생성 도구가 그대로 써요)</p>
      {fields.length > 0 && <div className="plans"><table className="grid">
        <thead><tr><th>이름</th><th>형식</th><th>필수</th>{fixed ? <th>길이 B</th> : <th>평균 B</th>}<th>설명</th><th /></tr></thead>
        <tbody>
          {fields.map((f, k) => (
            <tr key={k}>
              <td><input value={f.name} aria-invalid={!IDENT.test(f.name)} title={IDENT.test(f.name) ? '' : '영문·숫자·_ 만 (숫자로 시작하지 않음)'} onChange={(ev) => upd(k, { name: ev.target.value })} /></td>
              <td><Select value={f.type} onChange={(ev) => upd(k, { type: ev.target.value as SpecField['type'] })}>
                {FIELD_TYPES.map((t) => <option key={t} value={t}>{FIELD_NAMES[t]}</option>)}
              </Select></td>
              <td><input type="checkbox" checked={f.required} onChange={(ev) => upd(k, { required: ev.target.checked })} /></td>
              {fixed && <td><NumInput min={1} step={1} value={f.length ?? ''} aria-invalid={!f.length} onChange={(ev) => upd(k, { length: Number(ev.target.value) >= 1 ? Math.round(Number(ev.target.value)) : undefined })} /></td>}
              {/* 고정장은 길이로 크기를 정해 평균 B를 쓰지 않는다 */}
              {!fixed && <td><NumInput value={f.avg_bytes ?? ''} placeholder="예시" onChange={(ev) => upd(k, { avg_bytes: ev.target.value === '' || Number(ev.target.value) <= 0 ? undefined : Number(ev.target.value) })} /></td>}
              <td><input value={f.description ?? ''} onChange={(ev) => upd(k, { description: ev.target.value || undefined })} /></td>
              <td><button aria-label="필드 빼기" onClick={() => onChange(fields.filter((_, j) => j !== k))}>✕</button></td>
            </tr>
          ))}
        </tbody>
      </table></div>}
      <button onClick={() => {
        let n = fields.length + 1;
        while (fields.some((f) => f.name === `field${n}`)) n++;
        onChange([...fields, { name: `field${n}`, type: 'string', required: true }]);
      }}>+ 필드</button>
    </div>
  );
}

/** 실패할 때 돌려주는 응답: 상태 코드, 앱 에러 코드, 설명. 본문은 모두 problem+json(type·title·status·detail·code) */
/** 이 기능이 읽고 쓰는 테이블 (테이블이 있는 노드에서 고름) */
function TableLinks({ i, project, onChange }: { i: Interface; project: Project; onChange: (t: NonNullable<Interface['tables']>) => void }) {
  const links = i.tables ?? [];
  const all = project.nodes.flatMap((n) => n.tables.map((t) => ({ node: n.id, table: t.name, label: `${n.name} · ${t.name}${t.label ? ` (${t.label})` : ''}` })));
  const upd = (k: number, patch: Partial<NonNullable<Interface['tables']>[number]>) => onChange(links.map((x, j) => (j === k ? { ...x, ...patch } : x)));
  // 아직 연결하지 않은 첫 테이블
  const free = all.find((t) => !links.some((x) => x.node === t.node && x.table === t.table));
  return (
    <div>
      <p className="muted">읽고 쓰는 테이블 — 기능별 테이블 표와 데이터 사전에 나와요</p>
      {!all.length && <p className="muted">테이블이 있는 DB 노드가 없어요. DB 노드의 테이블 명세에서 먼저 만들어 주세요.</p>}
      {links.length > 0 && <div className="plans"><table className="grid">
        <thead><tr><th>테이블</th><th>읽기·쓰기</th><th /></tr></thead>
        <tbody>
          {links.map((x, k) => (
            <tr key={k}>
              <td><Select value={`${x.node}\u0000${x.table}`} aria-label="테이블" onChange={(ev) => { const [node, table] = ev.target.value.split('\u0000'); upd(k, { node, table }); }}>
                {!all.some((t) => t.node === x.node && t.table === x.table) && <option value={`${x.node}\u0000${x.table}`}>{x.node}.{x.table} (없음)</option>}
                {all.map((t) => <option key={`${t.node}.${t.table}`} value={`${t.node}\u0000${t.table}`}>{t.label}</option>)}
              </Select></td>
              <td><Select value={x.op} aria-label="읽기·쓰기" onChange={(ev) => upd(k, { op: ev.target.value as 'read' | 'write' })}>
                <option value="read">읽기</option><option value="write">쓰기</option>
              </Select></td>
              <td><button aria-label="테이블 빼기" onClick={() => onChange(links.filter((_, j) => j !== k))}>✕</button></td>
            </tr>
          ))}
        </tbody>
      </table></div>}
      {free && <button onClick={() => onChange([...links, { node: free.node, table: free.table, op: isWrite(i) ? 'write' : 'read' }])}>+ 테이블</button>}
    </div>
  );
}

function Errors({ errors, onChange }: { errors: Interface['errors']; onChange: (e: Interface['errors']) => void }) {
  const upd = (k: number, patch: Partial<Interface['errors'][number]>) => onChange(errors.map((x, j) => (j === k ? { ...x, ...patch } : x)));
  return (
    <div>
      <p className="muted">에러 응답 — 본문은 모두 같은 형식(problem+json: title·status·detail·code)이라 프론트가 한 곳에서 처리해요</p>
      {errors.length > 0 && <div className="plans"><table className="grid">
        <thead><tr><th>상태</th><th>에러 코드</th><th>언제</th><th /></tr></thead>
        <tbody>
          {errors.map((x, k) => (
            <tr key={k}>
              <td><NumInput value={x.status} min={400} max={599} onChange={(ev) => upd(k, { status: Number(ev.target.value) || 400 })} /></td>
              <td><input value={x.code ?? ''} placeholder="예: SALES_DUPLICATE" onChange={(ev) => upd(k, { code: ev.target.value || undefined })} /></td>
              <td><input value={x.description} onChange={(ev) => upd(k, { description: ev.target.value })} /></td>
              <td><button aria-label="에러 빼기" onClick={() => onChange(errors.filter((_, j) => j !== k))}>✕</button></td>
            </tr>
          ))}
        </tbody>
      </table></div>}
      <button onClick={() => onChange([...errors, { status: 400, description: '요청 값이 올바르지 않음' }])}>+ 에러 응답</button>
    </div>
  );
}
