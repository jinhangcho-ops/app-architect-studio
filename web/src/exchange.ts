// 데이터 주고받기 추천값: 서비스 성격마다 흔히 쓰는 방식과 그 이유. 예시값이라 서비스에 맞게 바꿔 쓴다.
import type { Exchange } from '../../engine/schema';

type Kind = NonNullable<Exchange['service']>;
export const SERVICE_NAMES: Record<Kind, string> = {
  chat: '채팅·실시간 협업', live: '실시간 시세·대시보드', feed: '피드·SNS', commerce: '커머스·예약',
  content: '콘텐츠·읽기 위주', tracking: '행동 로그·분석 수집', iot: '기기 상태 모니터링',
};

export const RECOMMEND: Record<Kind, { ex: Omit<Exchange, 'service'>; why: string }> = {
  chat: { ex: { receive: 'streaming', refresh_s: 1, send: 'realtime', batch_s: 60 }, why: '새 메시지가 1초 안에 보여야 해서 연결을 열어 두고 서버가 밀어줍니다. 보낸 메시지도 바로 보내야 합니다.' },
  live: { ex: { receive: 'streaming', refresh_s: 2, send: 'realtime', batch_s: 60 }, why: '값이 계속 바뀌어 몇 초마다 새 값을 밀어줍니다. 사용자가 보내는 것은 적어 바로 보냅니다.' },
  feed: { ex: { receive: 'polling', refresh_s: 30, send: 'realtime', batch_s: 60 }, why: '새 글이 몇십 초 늦어도 괜찮아 30초마다 다시 받습니다. 좋아요·글쓰기는 바로 보냅니다.' },
  commerce: { ex: { receive: 'polling', refresh_s: 60, send: 'realtime', batch_s: 60 }, why: '재고·가격은 1분마다 확인하면 충분합니다. 주문·결제는 늦으면 안 되어 바로 보냅니다.' },
  content: { ex: { receive: 'polling', send: 'batch', batch_s: 60 }, why: '화면을 옮길 때만 받으면 됩니다. 조회 기록은 1분마다 모아 보내 요청을 줄입니다.' },
  tracking: { ex: { receive: 'polling', send: 'batch', batch_s: 30 }, why: '받을 것은 거의 없고, 행동 로그를 30초마다 모아 보내 요청 수를 크게 줄입니다.' },
  iot: { ex: { receive: 'streaming', refresh_s: 5, send: 'batch', batch_s: 10 }, why: '상태 변화를 5초마다 밀어주고, 기기에서 올리는 측정값은 10초마다 모아 보냅니다.' },
};
