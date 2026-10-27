// 설정의 "설계 메모": 장 제목과 본문(가벼운 마크다운)을 적는다. 순서대로 설계서 맨 앞 장들이 된다
import { useState } from 'react';
import type { Project } from '../../engine/schema';
import { Section } from './fields';
import { splitChapters } from './notes';
import { NoteView } from './NoteView';
import { usePick } from './store';

type Note = Project['notes'][number];

export function NotesSection() {
  const { project: p, edit } = usePick('project', 'edit');
  const [preview, setPreview] = useState<number>();
  const [paste, setPaste] = useState('');
  const setNotes = (fn: (n: Note[]) => Note[]) => edit((x) => ({ ...x, notes: fn(x.notes) }));
  const patch = (i: number, v: Partial<Note>) => setNotes((ns) => ns.map((n, k) => (k === i ? { ...n, ...v } : n)));
  const move = (i: number, d: -1 | 1) => setNotes((ns) => { const c = [...ns]; [c[i], c[i + d]] = [c[i + d], c[i]]; return c; });
  const put = (replace: boolean) => { const add = splitChapters(paste); setNotes((ns) => (replace ? add : [...ns, ...add])); setPaste(''); setPreview(undefined); };

  return (
    <Section id="s-notes" title="설계 메모" desc="개요·범위·화면 구성·보안처럼 글로 적는 장이에요. 순서대로 설계서 맨 앞에 들어가요. ### 소제목, - 목록, 1. 번호, | 표 |, ``` 코드 ```, **굵게**, `코드`를 쓸 수 있어요. 지운 장은 Ctrl+Z로 되돌려요.">
      {p.notes.map((n, i) => (
        <div key={i} className="note-edit">
          <div className="note-edit-head">
            <b>{i + 1}.</b>
            <input aria-label={`${i + 1}장 제목`} placeholder="장 제목" value={n.title} onChange={(e) => patch(i, { title: e.target.value })} />
            <button aria-label={`${i + 1}장 위로`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
            <button aria-label={`${i + 1}장 아래로`} disabled={i === p.notes.length - 1} onClick={() => move(i, 1)}>↓</button>
            <button onClick={() => setPreview(preview === i ? undefined : i)}>{preview === i ? '고치기' : '미리보기'}</button>
            <button aria-label={`${i + 1}장 지우기`} onClick={() => { setNotes((ns) => ns.filter((_, k) => k !== i)); setPreview(undefined); }}>지우기</button>
          </div>
          {preview === i
            ? <div className="note-preview"><NoteView body={n.body} /></div>
            : <textarea aria-label={`${i + 1}장 본문`} rows={10} value={n.body} onChange={(e) => patch(i, { body: e.target.value })} />}
        </div>
      ))}
      <button onClick={() => { setNotes((ns) => [...ns, { title: '', body: '' }]); setPreview(undefined); }}>+ 장 추가</button>
      <details className="note-paste">
        <summary>마크다운 문서 붙여 넣기 (## 제목마다 장으로 나눔)</summary>
        <textarea aria-label="붙여 넣을 마크다운" rows={8} placeholder={'## 1. 개요\n…\n## 2. 범위\n…'} value={paste} onChange={(e) => setPaste(e.target.value)} />
        <button disabled={!paste.trim()} onClick={() => put(false)}>{p.notes.length ? '지금 장 뒤에 붙이기' : '장으로 나눠 넣기'}</button>
        {p.notes.length > 0 && <button disabled={!paste.trim()} onClick={() => put(true)}>지금 장을 모두 바꾸기</button>}
      </details>
    </Section>
  );
}
