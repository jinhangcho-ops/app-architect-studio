// @vitest-environment happy-dom
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { notesText, subjectParticle, UpdatePrompt } from './UpdatePrompt';

/** 알림을 그리고 [업데이트]를 눌러 창을 연다 */
function openDialog(notes?: string) {
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  flushSync(() => root.render(<UpdatePrompt info={{ current: '1.1.1', version: '1.1.2', tag: 'v1.1.2', notes }} prepare={() => undefined} />));
  const banner = el.querySelector('.update')!.textContent;
  flushSync(() => (el.querySelector('.update button') as HTMLButtonElement).click());
  return { el, banner, done: () => { root.unmount(); el.remove(); } };
}

describe('새 버전 알림 화면', () => {
  it('위쪽 알림 → [업데이트]를 누르면 "vA → vB에서 바뀐 것" 창과 [지금 업데이트]·[나중에]', () => {
    const { el, banner, done } = openDialog('### 추가\n- 새 기능');
    expect(banner).toContain('새 버전 v1.1.2가 있어요');
    expect(el.querySelector('[role=dialog]')!.textContent).toContain('v1.1.1 → v1.1.2에서 바뀐 것');
    expect([...el.querySelectorAll('[role=dialog] button')].map((b) => b.textContent)).toEqual(['지금 업데이트', '나중에']);
    done();
  });

  it('릴리스 노트는 글자로만 넣고(HTML로 해석하지 않음) ## · ### 머리는 ■로', () => {
    const { el, done } = openDialog('## v1.1.2\n### 추가\n- <img src=x onerror="alert(1)"> 새 기능\n### 삭제\n- 없음');
    const box = el.querySelector('.release-notes')!;
    expect(box.querySelector('img')).toBeNull();
    expect(box.textContent).toBe('■ v1.1.2\n■ 추가\n- <img src=x onerror="alert(1)"> 새 기능\n■ 삭제\n- 없음');
    done();
  });

  it('노트를 못 받았으면 GitHub Releases에서 보라고 알림', () => {
    const { el, done } = openDialog(undefined);
    expect(el.querySelector('[role=dialog]')!.textContent).toContain('릴리스 노트를 받지 못했어요. GitHub Releases에서 볼 수 있어요.');
    done();
  });

  it('버전 끝 숫자를 읽는 소리에 따라 이/가', () => {
    expect(['1.1.0', '1.1.1', '1.1.2', '1.1.3', '1.1.4', '1.1.5', '1.1.6', '1.1.7', '1.1.8', '1.1.9', '1.2.10'].map(subjectParticle))
      .toEqual(['이', '이', '가', '이', '가', '가', '이', '이', '이', '가', '이']);
    expect(subjectParticle('1.0.0-rc')).toBe('이(가)');
  });

  it('머리 바꾸기는 줄 맨 앞의 ##·###만', () => {
    expect(notesText('## a\n### b\n#### c\n- x ## y')).toBe('■ a\n■ b\n#### c\n- x ## y');
  });
});
