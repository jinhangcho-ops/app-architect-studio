// 설계 메모 본문을 그린다 (설계서·설정 미리보기·노드 패널이 같이 씀). React 요소만 만들어 메모 속 HTML은 글자로 보인다
import { Fragment } from 'react';
import { parseInline, parseNote, type ListItem } from './notes';

/** 글 한 덩이: 줄바꿈은 그대로, **굵게**·`코드` */
function Inline({ text }: { text: string }) {
  return <>{text.split('\n').map((line, i) => (
    <Fragment key={i}>{i > 0 && <br />}{parseInline(line).map((s, k) => (
      s.kind === 'bold' ? <b key={k}>{s.text}</b> : s.kind === 'code' ? <code key={k}>{s.text}</code> : <Fragment key={k}>{s.text}</Fragment>
    ))}</Fragment>
  ))}</>;
}

/** 목록: 깊이마다 들여 쓰고, 번호는 적은 그대로 (빈 줄로 나뉜 1. 2. 3.이 1. 1. 1.이 되지 않게) */
function List({ items }: { items: ListItem[] }) {
  return <div className="note-list">{items.map((it, i) => (
    <div key={i} className="note-li" style={{ paddingLeft: `${it.depth * 1.2}em` }}>
      <span className="note-mark">{it.num ?? '•'}</span><span><Inline text={it.text} /></span>
    </div>
  ))}</div>;
}

export function NoteView({ body }: { body: string }) {
  return <div className="note">{parseNote(body).map((b, i) => {
    switch (b.kind) {
      case 'heading': {
        const Tag = b.level <= 2 ? 'h3' : b.level === 3 ? 'h4' : 'h5';
        return <Tag key={i} className="note-h"><Inline text={b.text} /></Tag>;
      }
      case 'paragraph': return <p key={i}><Inline text={b.text} /></p>;
      case 'quote': return <blockquote key={i}><Inline text={b.text} /></blockquote>;
      case 'list': return <List key={i} items={b.items} />;
      case 'rule': return <hr key={i} />;
      case 'code': return <pre key={i} className="note-code">{b.text}</pre>;
      case 'table': return (
        <table key={i} className="note-table">
          {b.head.length > 0 && <thead><tr>{b.head.map((c, k) => <th key={k}><Inline text={c} /></th>)}</tr></thead>}
          <tbody>{b.rows.map((r, k) => <tr key={k}>{r.map((c, j) => <td key={j}><Inline text={c} /></td>)}</tr>)}</tbody>
        </table>
      );
    }
  })}</div>;
}
