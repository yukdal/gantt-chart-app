// 다크모드 토글 (12단계)
// - 기본은 시스템 설정(prefers-color-scheme)을 따른다. CSS(@media)가 이를 자동 반영한다.
// - 사용자가 툴바의 "다크모드/라이트모드" 버튼을 눌러 명시적으로 선택하면
//   localStorage('gantt.theme')에 'light'|'dark' 로 저장해 시스템 설정보다 우선시킨다.
//   (선택한 적이 없으면 키 자체가 없어야 하므로, 이 파일은 사용자가 실제로
//   클릭했을 때만 setItem 한다.)
// - 최초 페이지 로드 시 깜빡임(FOUC) 방지는 index.html <head> 의 인라인 스크립트가
//   담당한다(body 렌더 전에 저장된 값이 있으면 data-theme 를 미리 지정). 이 파일은
//   그 뒤에 실행되며 버튼 라벨 초기화와 클릭 토글만 다룬다.
(function () {
  'use strict';

  var THEME_KEY = 'gantt.theme'; // gantt.zoom(gantt.js) 과 동일한 네이밍 컨벤션

  // 시스템이 다크를 선호하는지 여부 (matchMedia 미지원 환경은 라이트로 간주)
  function systemPrefersDark() {
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  // localStorage 에 사용자가 명시적으로 저장한 값을 읽는다. 없거나 손상 시 null.
  function readSaved() {
    try {
      var v = window.localStorage.getItem(THEME_KEY);
      return (v === 'light' || v === 'dark') ? v : null;
    } catch (e) {
      return null; // localStorage 접근 불가(사생활 보호 모드 등)
    }
  }

  // 현재 실제로 적용되는 유효 테마: 저장된 값이 있으면 그 값, 없으면 시스템 설정.
  function currentTheme() {
    var saved = readSaved();
    return saved || (systemPrefersDark() ? 'dark' : 'light');
  }

  // 버튼 라벨/title 을 "클릭 시 전환될 대상"으로 갱신한다 (다른 툴바 버튼과 톤 통일).
  function updateButton() {
    var btn = document.getElementById('btn-theme');
    if (!btn) return;
    var isDark = currentTheme() === 'dark';
    btn.textContent = isDark ? '라이트모드' : '다크모드';
    btn.title = isDark ? '라이트모드로 전환' : '다크모드로 전환';
  }

  // 사용자의 명시적 선택을 저장하고 즉시 반영한다.
  function toggleTheme() {
    var next = currentTheme() === 'dark' ? 'light' : 'dark';
    try { window.localStorage.setItem(THEME_KEY, next); }
    catch (e) { /* 저장 실패해도 이번 세션 내에서는 아래 속성 적용으로 동작은 유지 */ }
    document.documentElement.setAttribute('data-theme', next);
    updateButton();
  }

  document.addEventListener('DOMContentLoaded', function () {
    updateButton();

    var btn = document.getElementById('btn-theme');
    if (btn) btn.addEventListener('click', toggleTheme);

    // 사용자가 선택한 적이 없을 때만: 시스템 설정이 바뀌면 버튼 라벨을 실시간으로 맞춘다.
    // (data-theme 속성을 건드리지 않으므로 CSS 의 prefers-color-scheme 감지를 그대로 둔다.)
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var onSystemChange = function () {
        if (readSaved()) return; // 사용자가 이미 명시적으로 골랐으면 무시
        updateButton();
      };
      if (mq.addEventListener) mq.addEventListener('change', onSystemChange);
      else if (mq.addListener) mq.addListener(onSystemChange); // 구형 브라우저 호환
    }
  });
})();
