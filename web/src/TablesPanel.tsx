// 노드 패널의 데이터 부분: 명세서 붙여넣기, 테이블 편집, 저장 기능 선택.
import { Select } from './Select';
import { useState } from 'react';
import { COLUMN_TYPES, nodeStorageProfile, selectedFeatures, STORAGE_FORMATS, STORAGE_NAMES, type Project, type ProjectNode } from '../../engine/schema';
import { parseSpec } from '../../engine/spec';
import { schemaWarnings } from '../../engine/ddl';
import { catalog } from './data';
import { addTable, importTables, patchAt, removeColumn, removeTable, renameColumn, setFeature, updateNode, updateTable } from './edit';
import { NumField, Row, Section, TextField } from './fields';
import { usePick } from './store';

type Table = ProjectNode['tables'][number];
type Column = Table['columns'][number];

const TEMPLATE = '테이블\t컬럼\t타입\t크기\t평균 길이\t저장 형식\tNULL\t키·인덱스\t설명';
const csv = (xs: string[]) => xs.join(', ');
const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
/** 코드 값 "C=카드; M=현금" ↔ [{code, label}]. 데이터 사전 CSV처럼 ;로 나눠 라벨의 쉼표는 그대로 둔다 */
export const codesText = (cs?: Column['codes']) => (cs ?? []).map((x) => (x.label ? `${x.code}=${x.label}` : x.code)).join('; ');
export const parseCodes = (s: string): Column['codes'] => {
  const cs = s.split(';').map((x) => x.trim()).filter(Boolean).map((x) => { const [code, ...rest] = x.split('='); return { code: code.trim(), label: rest.join('=').trim() }; }).filter((x) => x.code);
  return cs.length ? cs : undefined;
};

/** 칸을 나올 때 저장하는 글자 칸. 바깥 값이 바뀌면(되돌리기 등) 새로 그리고, 값이 그대로면 저장하지 않는다.
 *  저장 뒤 정리한 값이 그대로면(띄어쓰기만 다름) 새로 그려지지 않으니 칸 글자를 지금 값으로 되돌린다 */
function BlurInput({ value, onSave, ...rest }: { value: string; onSave: (v: string) => void; 'aria-label'?: string; placeholder?: string }) {
  return <input key={value} defaultValue={value} {...rest} onBlur={(e) => { if (e.target.value !== value) onSave(e.target.value); e.target.value = value; }} />;
}

/** 새 인덱스 기본 이름 idx_테이블_n — 같은 노드(한 스키마)의 다른 테이블 인덱스와 겹치지 않게 n을 올린다 */
function newIndexName(node: ProjectNode, t: Table) {
  const used = new Set(node.tables.flatMap((x) => x.indexes.map((i) => i.name)));
  let n = t.indexes.length + 1;
  while (used.has(`idx_${t.name}_${n}`)) n++;
  return `idx_${t.name}_${n}`;
}

export function TablesSection({ node }: { node: ProjectNode }) {
  const { edit } = usePick('edit');
  const [spec, setSpec] = useState('');
  const [report, setReport] = useState<{ ok?: string; errors: string[] }>({ errors: [] });

  const importSpec = () => {
    const r = parseSpec(spec);
    let replaced: string[] = [];
    if (r.tables.length) edit((p) => { const x = importTables(p, node.id, r.tables); replaced = x.replaced; return x.project; });
    setReport({
      ok: r.tables.length ? `테이블 ${r.tables.length}개를 가져왔습니다${replaced.length ? ` (같은 이름 ${replaced.join(', ')}은 바꿈)` : ''}` : undefined,
      errors: r.errors,
    });
    if (r.tables.length && !r.errors.length) setSpec('');
  };

  return (
    <Section title={`테이블 (${node.tables.length})`}>
      <details>
        <summary>명세서 붙여넣기</summary>
        <p className="muted">엑셀 표를 복사해 붙여 넣거나 CSV·JSON을 넣습니다. 첫 줄은 머리글입니다. 키 칸: PK, PK:2, UQ:이름, idx_이름:순서</p>
        <textarea className="spec" value={spec} placeholder={TEMPLATE} onChange={(e) => setSpec(e.target.value)} />
        <div className="inline">
          <button onClick={importSpec} disabled={!spec.trim()}>가져오기</button>
          <button onClick={() => setSpec(TEMPLATE + '\n')}>머리글 넣기</button>
        </div>
        {report.ok && <p>{report.ok}</p>}
        {report.errors.length > 0 && <ul className="warn">{report.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      </details>
      {node.tables.map((t) => <TableEditor key={t.name} node={node} t={t} />)}
      <button onClick={() => edit((p) => addTable(p, node.id))}>테이블 추가</button>
    </Section>
  );
}

// 편집기마다 프로젝트 전체 경고를 세지 않게 같은 프로젝트(객체)면 한 번만
const warnCache = new WeakMap<Project, ReturnType<typeof schemaWarnings>>();
const warningsOf = (p: Project) => {
  let w = warnCache.get(p);
  if (!w) warnCache.set(p, (w = schemaWarnings(p, catalog.byId)));
  return w;
};

export function TableEditor({ node, t, open, onRename }: { node: ProjectNode; t: Table; open?: boolean; onRename?: (name: string) => void }) {
  const { project, edit } = usePick('project', 'edit');
  const upd = (patch: Partial<Table>) => edit((p) => updateTable(p, node.id, t.name, patch));
  const warns = warningsOf(project).filter((w) => w.node === node.id && w.table === t.name);
  const setCol = (i: number, patch: Partial<Column>) => upd({ columns: patchAt(t.columns, i, patch) });
  const setIx = (i: number, patch: Partial<Table['indexes'][number]>) => upd({ indexes: patchAt(t.indexes, i, patch) });
  const padded = !!nodeStorageProfile(node, catalog.byId)?.fixed_width_padded;

  return (
    <details className="table-editor" open={open}>
      <summary><b>{t.name}</b>{t.label && ` ${t.label}`} <span className="muted">{t.record === 'fixed' ? '고정장 · ' : ''}컬럼 {t.columns.length} · 인덱스 {t.indexes.length}{t.partition ? ' · 파티션' : ''}</span></summary>
      {warns.length > 0 && <div className="warn">{warns.map((w, i) => <div key={i}>⚠️ {w.text}</div>)}</div>}
      <Row label="이름"><input defaultValue={t.name} onBlur={(e) => {
        if (!e.target.value || e.target.value === t.name) return;
        // 같은 노드에 이미 있는 이름이면 두 테이블이 한꺼번에 고쳐지므로 받지 않는다
        if (node.tables.some((x) => x.name === e.target.value)) { e.target.value = t.name; return; }
        upd({ name: e.target.value }); onRename?.(e.target.value);
      }} /></Row>
      <TextField label="논리명" value={t.label} onChange={(v) => upd({ label: v || undefined })} />
      <TextField label="설명" value={t.description} onChange={(v) => upd({ description: v || undefined })} />
      <Row label="장 형식" hint={`고정장: 문자열·바이너리를 최대 길이만큼 채워 저장(CHAR(n)·BINARY(n)). 가변장: 실제 길이(VARCHAR). ${padded ? '이 시스템은 고정장이면 최대 길이로 크기를 계산해요' : '이 시스템은 고정 길이 문자열도 실제 길이로 저장해 크기는 같아요'}`}>
        <Select value={t.record} onChange={(e) => upd({ record: e.target.value as Table['record'] })}>
          <option value="variable">가변장</option><option value="fixed">고정장</option>
        </Select>
      </Row>
      <NumField label="보관 일수" value={t.retention_days} hint="비우면 프로젝트 보관 기간" onChange={(v) => upd({ retention_days: v })} />
      <NumField label="갱신 비율" value={t.update_ratio} step={0.05} hint="쓰기 중 새 행이 아니라 기존 행을 고치는 비율" onChange={(v) => upd({ update_ratio: v ?? 0 })} />
      <Row label="기본 키" hint="쉼표로 구분, 순서대로">
        <BlurInput value={csv(t.primary_key)} aria-label="기본 키" onSave={(v) => upd({ primary_key: list(v) })} />
      </Row>
      <Row label="파티션">
        <span className="inline">
          <Select value={t.partition?.column ?? ''} onChange={(e) => upd({ partition: e.target.value ? { column: e.target.value, interval: t.partition?.interval ?? 'month' } : undefined })}>
            <option value="">(없음)</option>
            {t.columns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
          </Select>
          {t.partition && <Select value={t.partition.interval} onChange={(e) => upd({ partition: { ...t.partition!, interval: e.target.value as 'day' } })}>
            <option value="day">일</option><option value="week">주</option><option value="month">월</option>
          </Select>}
        </span>
      </Row>

      <div className="plans"><table className="grid">
        <thead><tr><th>컬럼</th><th>타입</th><th>저장 형식</th><th>최대</th><th>평균</th><th>NULL</th><th /></tr></thead>
        <tbody>{t.columns.map((c, i) => (
          // 글자 칸은 BlurInput이 값마다 새로 그려서 줄 키는 순서만 — 이름을 저장해도 옆 칸 포커스가 남는다
          <tr key={i}>
            <td><BlurInput value={c.name} onSave={(v) => { const r = v && renameColumn(t, c.name, v); if (r) upd(r); }} /></td>
            <td><Select value={c.type} onChange={(e) => setCol(i, { type: e.target.value as Column['type'] })}>
              {COLUMN_TYPES.map((x) => <option key={x}>{x}</option>)}
            </Select></td>
            <td><Select value={c.storage ?? ''} onChange={(e) => setCol(i, { storage: (e.target.value || undefined) as Column['storage'] })}>
              <option value="">(기본)</option>
              {STORAGE_FORMATS.map((x) => <option key={x} value={x}>{STORAGE_NAMES[x]}</option>)}
            </Select></td>
            <td><input type="number" value={c.max_length ?? ''} aria-invalid={t.record === 'fixed' && (c.type === 'text' || c.type === 'bytes') && !c.max_length} onChange={(e) => setCol(i, { max_length: e.target.value ? Number(e.target.value) : undefined })} /></td>
            <td><input type="number" value={c.avg_bytes ?? ''} onChange={(e) => setCol(i, { avg_bytes: e.target.value ? Number(e.target.value) : undefined })} /></td>
            <td><input type="checkbox" checked={c.nullable} onChange={(e) => setCol(i, { nullable: e.target.checked })} /></td>
            <td><button aria-label="컬럼 삭제" onClick={() => upd(removeColumn(t, i))}>×</button></td>
          </tr>
        ))}</tbody>
      </table></div>
      <button onClick={() => upd({ columns: [...t.columns, { name: `col_${t.columns.length + 1}`, type: 'text', nullable: false, personal: false }] })}>컬럼 추가</button>

      <details>
        <summary>데이터 사전 (논리명·도메인·코드 값·기본값·개인정보)</summary>
        <p className="muted">코드 값은 "C=카드; M=현금"처럼 ;로. 넣으면 DDL에 CHECK 제약이 들어가요. 기본값·코드 값은 컬럼 타입에 맞게(정수는 숫자, 참·거짓은 true/false, 시각은 CURRENT_TIMESTAMP나 날짜 글자). 맞지 않으면 경고가 떠요</p>
        <div className="plans"><table className="grid">
          <thead><tr><th>컬럼</th><th>논리명</th><th>도메인</th><th>코드 값</th><th>기본값</th><th>개인정보</th><th>설명</th></tr></thead>
          <tbody>{t.columns.map((c, i) => (
            <tr key={i}>
              <td>{c.name}</td>
              <td><BlurInput value={c.label ?? ''} aria-label={`${c.name} 논리명`} onSave={(v) => setCol(i, { label: v || undefined })} /></td>
              <td><BlurInput value={c.domain ?? ''} aria-label={`${c.name} 도메인`} placeholder="금액·코드·일시…" onSave={(v) => setCol(i, { domain: v || undefined })} /></td>
              <td><BlurInput value={codesText(c.codes)} aria-label={`${c.name} 코드 값`} onSave={(v) => setCol(i, { codes: parseCodes(v) })} /></td>
              <td><BlurInput value={c.default_value ?? ''} aria-label={`${c.name} 기본값`} onSave={(v) => setCol(i, { default_value: v || undefined })} /></td>
              <td><input type="checkbox" checked={c.personal} aria-label={`${c.name} 개인정보`} onChange={(e) => setCol(i, { personal: e.target.checked })} /></td>
              <td><BlurInput value={c.description ?? ''} aria-label={`${c.name} 설명`} onSave={(v) => setCol(i, { description: v || undefined })} /></td>
            </tr>
          ))}</tbody>
        </table></div>
      </details>

      <div className="plans"><table className="grid">
        <thead><tr><th>인덱스</th><th>컬럼(쉼표)</th><th>고유</th><th /></tr></thead>
        <tbody>{t.indexes.map((x, i) => (
          <tr key={i}>
            <td><BlurInput value={x.name} onSave={(v) => v && setIx(i, { name: v })} /></td>
            <td><BlurInput value={csv(x.columns)} onSave={(v) => setIx(i, { columns: list(v) })} /></td>
            <td><input type="checkbox" checked={x.unique} onChange={(e) => setIx(i, { unique: e.target.checked })} /></td>
            <td><button aria-label="인덱스 삭제" onClick={() => upd({ indexes: t.indexes.filter((_, k) => k !== i) })}>×</button></td>
          </tr>
        ))}</tbody>
      </table></div>
      <button onClick={() => upd({ indexes: [...t.indexes, { name: newIndexName(node, t), columns: [t.columns[0].name], unique: false }] })}>인덱스 추가</button>
      <button className="danger" onClick={() => edit((p) => removeTable(p, node.id, t.name))}>테이블 삭제</button>
    </details>
  );
}

/** 주 항목의 저장 프로필에서 기능 고르기. 아무것도 안 고르면 권장 기능이 켜진다 */
export function StorageSection({ node }: { node: ProjectNode }) {
  const { edit } = usePick('edit');
  const sp = nodeStorageProfile(node, catalog.byId);
  if (!sp) return null;
  const on = selectedFeatures(sp, node).map((f) => f.id);
  const set = (ids: string[] | undefined) => edit((p) => updateNode(p, node.id, { storage_features: ids }));
  return (
    <Section title="저장 기능">
      {sp.note && <p className="muted">{sp.note}</p>}
      {Object.entries(sp.groups).map(([g, def]) => (
        <div key={g} className="feature-group">
          <div className="muted">{def.label}{def.one ? '' : ' (여러 개)'}</div>
          {sp.features.filter((f) => f.group === g).map((f) => (
            <label key={f.id} title={[f.note, f.source].filter(Boolean).join('\n')}>
              <input type={def.one ? 'radio' : 'checkbox'} name={`${node.id}-${g}`} checked={on.includes(f.id)}
                onChange={(e) => edit((p) => setFeature(p, node.id, f.id, e.target.checked))} />
              {f.label}{f.recommended && <span className="tag">권장</span>}
            </label>
          ))}
        </div>
      ))}
      <div className="inline">
        <span className="muted">{node.storage_features ? '직접 고름' : '권장 기능 사용 중'}</span>
        {node.storage_features && <button onClick={() => set(undefined)}>권장으로 되돌리기</button>}
      </div>
    </Section>
  );
}
