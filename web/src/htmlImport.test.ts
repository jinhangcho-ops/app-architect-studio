// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { apiFor, parseHtml } from './htmlImport';

// happy-dom 환경에서는 import.meta.url이 file:이 아니라서 저장소 루트(테스트 실행 위치) 기준으로 읽는다
const html = readFileSync(join(process.cwd(), 'examples/html/order_checkout.html'), 'utf8');
const r = parseHtml(html);

describe('관문: v2 예시 화면(order_checkout.html)에서 영역 7개', () => {
  it('헤더·네비·메인·폼·표·사이드바·푸터', () => {
    expect(r.regions.map((x) => `${x.role} ${x.selector}`)).toEqual([
      '상단 헤더 header#top-header',
      '네비게이션 nav.gnb-navbar',
      '메인 main#checkout-main',
      '입력 폼 form#order-payment-form',
      '표 table.order-item-table',
      '사이드바 aside.order-sidebar',
      '하단 푸터 footer#page-footer',
    ]);
  });

  it('영역 안 컨트롤을 종류별로 적음', () => {
    const form = r.regions.find((x) => x.role === '입력 폼')!;
    expect(form.controls).toEqual(['[입력:text] 국가별 주소 포맷', '[선택창] local_pg_method', '[버튼] 결제 요청']);
    expect(r.regions.find((x) => x.role === '표')!.controls).toContain('[컬럼] 현지 통화 금액');
  });

  it('폼 action과 data-api에서 API 경로 후보를 찾음 (일반 링크는 제외)', () => {
    expect(r.apiCalls).toEqual([{ method: 'POST', path: '/api/v2/orders' }, { method: 'GET', path: '/api/v2/pricing' }]);
  });

  it('data-api 앞뒤 공백은 무시', () => {
    expect(parseHtml('<button data-api="  post /api/x ">a</button><button data-api=" /api/y">b</button>').apiCalls)
      .toEqual([{ method: 'POST', path: '/api/x' }, { method: 'GET', path: '/api/y' }]);
  });

  it('시맨틱 태그가 아니어도 클래스 이름으로 역할을 맞힘', () => {
    const div = parseHtml('<div class="modal-popup"><button>닫기</button></div><div id="left-sidebar"></div>');
    expect(div.regions.map((x) => x.role)).toEqual(['모달', '사이드바']);
  });
});

describe('링크의 API: HTML <a>와 SVG 안의 <a> 모두', () => {
  it('/api로 시작하는 링크는 GET 호출, 일반 링크는 아님', () => {
    const doc = new DOMParser().parseFromString('<a id="h" href="/api/list">목록</a><a id="n" href="/about">소개</a><svg><a id="s" href="/api/like"><text>♥</text></a></svg>', 'text/html');
    const api = (id: string) => apiFor(doc.getElementById(id)!, false, new Set())?.path;
    expect([api('h'), api('n'), api('s')]).toEqual(['/api/list', undefined, '/api/like']);
  });
});
