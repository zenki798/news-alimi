// 수집기의 글자 정리 — 피드에서 받은 제목·요약이 화면에 깨끗하게 나오는지 (네트워크 없이 본다)
const { test, expect } = require('@playwright/test');
const { clean } = require('../scripts/fetch-news');

test('두 번 감싼 이스케이프도 푼다 (연합뉴스 요약: E&amp;amp;S)', () => {
  /* 요약은 HTML 을 XML 로 한 번 더 감싸 오는 피드가 있다. 한 번만 풀면 화면에 E&amp;S 가 보인다. */
  expect(clean('SK이노베이션 E&amp;amp;S가 호주에서')).toBe('SK이노베이션 E&S가 호주에서');
  expect(clean('연구·개발(R&amp;amp;D) 투자')).toBe('연구·개발(R&D) 투자');
  expect(clean('&amp;quot;수출 주도 지속 불가능&amp;quot;')).toBe('"수출 주도 지속 불가능"');
});

test('한 번 감싼 것·CDATA·태그는 전처럼 정리한다', () => {
  expect(clean('SK이노 E&amp;S, 호주LNG')).toBe('SK이노 E&S, 호주LNG');
  expect(clean('<![CDATA[<p>AT&amp;T 와 <b>협력</b></p>]]>')).toBe('AT&T 와 협력');
  expect(clean('  줄바꿈과\n\n  공백이   많은 글  ')).toBe('줄바꿈과 공백이 많은 글');
  expect(clean('')).toBe('');
});

test('제목 앞의 <속보> 같은 꺾쇠 머리표는 지우지 않는다', () => {
  expect(clean('&lt;속보&gt; 코스피 2,500 돌파')).toBe('<속보> 코스피 2,500 돌파');
});
