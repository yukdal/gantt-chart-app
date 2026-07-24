// 내보내기 캡처 공용 유틸 (PNG/PPTX 공용) — html2canvas 옵션을 한 곳에서 관리한다.
//
// [배경: 내보낸 이미지가 "스타일 없는 HTML"처럼 깨지던 버그]
// html2canvas 1.4.1 은 캡처 대상을 그대로 그리지 않고, 숨겨진 iframe 에 문서 전체를
// 복제(clone)한 뒤 그 복제본의 computed style 을 읽어 캔버스에 그린다. 이때 복제된
// <head> 안의 <link rel="stylesheet" href="/css/style.css"> 는 복제 문서에서 "다시"
// 네트워크로 내려받는다. 이 재요청이 실패하거나 늦어지면 복제본에는 스타일시트가
// 전혀 적용되지 않은 채로 렌더가 진행되고, 결과 이미지는
//   - 좌우 분할(flex)·격자·태스크 바·날짜축 칸이 모두 사라지고
//   - 텍스트만 위에서 아래로 흘러내리며
//   - 색·굵기를 태그 속성으로 직접 갖는 SVG 의존성 화살표만 정상으로 보이는
// 형태가 된다. (개발 모드에서는 정적 파일이 Cache-Control: no-store 라 캡처할 때마다
// 매번 새로 내려받으므로 이 재요청이 실패할 여지가 그만큼 커진다.)
//
// [대책]
// 1) 복제 문서에 원본 스타일시트 "본문"을 <style> 로 직접 심는다. 네트워크 재요청
//    성공 여부와 무관하게 스타일이 항상 존재하게 만드는 것이 핵심 수정이다.
// 2) 복제 루트에 data-theme="light" 를 강제하고, 라이트 기준으로 해석한 CSS 커스텀
//    프로퍼티(--x) 값을 리터럴로 인라인 주입한다. 사용자가 다크모드로 보고 있어도
//    내보낸 이미지는 항상 흰 배경 + 검은 글씨가 된다.
// 3) 캡처 대상 요소 자체에도 배경/글자색을 명시해, 다크 상태인 body 에서 상속된
//    밝은 글자색이 흰 배경 위로 새어 나오지 않게 한다.
//
// 사용법: window.ExportCapture.h2cOptions(scale, width, height) 를 png.js/pptx.js 가
// 그대로 html2canvas 두 번째 인자로 넘긴다.
(function () {
  'use strict';

  if (typeof document === 'undefined') return;

  // 원본 문서의 라이트 톤 기준값 (스타일시트를 못 읽는 최악의 경우 대비 기본값)
  var FALLBACK_TEXT = '#1f2933';
  var FALLBACK_BG = '#ffffff';

  // 문서 스타일시트 본문·변수 이름 목록은 한 번만 모아서 재사용한다 (캡처마다 재계산 방지).
  var cssTextCache = null;
  var varNamesCache = null;

  /**
   * 같은 출처의 모든 스타일시트 규칙 본문을 하나의 문자열로 모은다.
   * 크로스 오리진 등으로 cssRules 접근이 막힌 시트는 건너뛴다(예외 무시).
   * @returns {string} 전체 CSS 텍스트 (실패 시 빈 문자열)
   */
  function collectCssText() {
    if (cssTextCache !== null) return cssTextCache;
    var out = [];
    var sheets = document.styleSheets;
    for (var i = 0; i < sheets.length; i++) {
      var rules = null;
      try {
        rules = sheets[i].cssRules; // 접근 불가 시 SecurityError
      } catch (e) {
        rules = null;
      }
      if (!rules) continue;
      for (var j = 0; j < rules.length; j++) {
        var text = rules[j] && rules[j].cssText;
        if (typeof text === 'string') out.push(text);
      }
    }
    cssTextCache = out.join('\n');
    return cssTextCache;
  }

  /**
   * 스타일시트를 훑어 정의된 CSS 커스텀 프로퍼티(--로 시작) 이름을 모두 모은다.
   * (하드코딩 나열 대신 실제 정의를 읽으므로 변수를 추가·삭제해도 자동 반영된다.)
   * @returns {string[]} 중복 없는 변수 이름 배열
   */
  function collectVarNames() {
    if (varNamesCache !== null) return varNamesCache;
    var seen = {};
    var names = [];

    // 규칙 트리를 재귀로 훑는다 (@media 등 그룹 규칙 안쪽까지)
    function walk(rules) {
      if (!rules) return;
      for (var i = 0; i < rules.length; i++) {
        var rule = rules[i];
        if (rule && rule.style) {
          for (var k = 0; k < rule.style.length; k++) {
            var prop = rule.style[k];
            if (prop && prop.indexOf('--') === 0 && !seen[prop]) {
              seen[prop] = true;
              names.push(prop);
            }
          }
        }
        // @media / @supports 같은 그룹 규칙 내부도 확인
        var inner = null;
        try { inner = rule && rule.cssRules; } catch (e) { inner = null; }
        if (inner) walk(inner);
      }
    }

    var sheets = document.styleSheets;
    for (var s = 0; s < sheets.length; s++) {
      try { walk(sheets[s].cssRules); } catch (e) { /* 접근 불가 시트는 건너뜀 */ }
    }
    varNamesCache = names;
    return names;
  }

  /**
   * "라이트 톤으로 해석한" 커스텀 프로퍼티 값 스냅샷을 만든다.
   * 화면이 다크모드여도, .export-force-light 를 입힌 임시 요소의 computed style 을
   * 읽으므로 색 변수는 라이트 값이 나오고 레이아웃 변수(--left-w 등)는 원래 값이 나온다.
   * @returns {Object} { '--border': '#d7dde5', ... }
   */
  function lightVarSnapshot() {
    var names = collectVarNames();
    var snap = {};
    if (names.length === 0) return snap;

    var probe = document.createElement('div');
    probe.className = 'export-force-light';
    probe.setAttribute('aria-hidden', 'true');
    probe.style.position = 'absolute';
    probe.style.left = '-99999px';
    probe.style.top = '0';
    probe.style.width = '0';
    probe.style.height = '0';
    probe.style.visibility = 'hidden';
    document.body.appendChild(probe);
    try {
      var cs = window.getComputedStyle(probe);
      for (var i = 0; i < names.length; i++) {
        var v = cs.getPropertyValue(names[i]);
        if (v) snap[names[i]] = v.trim();
      }
    } finally {
      if (probe.parentNode) probe.parentNode.removeChild(probe);
    }
    return snap;
  }

  /**
   * html2canvas 가 복제 문서를 다 만든 뒤(렌더 직전) 호출하는 콜백.
   * 스타일시트 본문 주입 + 라이트 테마 강제 + 커스텀 프로퍼티 인라인 주입을 수행한다.
   * 어떤 단계가 실패해도 캡처 자체는 계속되도록 전부 try/catch 로 감싼다.
   * @param {Document} clonedDoc html2canvas 가 만든 복제 문서
   * @param {Element} element   복제본 안의 캡처 대상 요소(원본 wrapper 에 대응)
   */
  function onCloneForExport(clonedDoc, element) {
    try {
      var root = clonedDoc.documentElement;

      // (1) 라이트 강제 — @media (prefers-color-scheme: dark) 는 :root:not([data-theme="light"])
      //     조건이라 이 속성만으로 무력화되고, :root[data-theme="light"] 규칙이 적용된다.
      if (root) root.setAttribute('data-theme', 'light');

      // (2) 스타일시트 본문을 <style> 로 직접 심는다 (link 재요청 실패와 무관하게 스타일 보장)
      var css = collectCssText();
      if (css) {
        var styleEl = clonedDoc.createElement('style');
        styleEl.setAttribute('data-export-inline-css', 'true');
        styleEl.textContent = css;
        (clonedDoc.head || root).appendChild(styleEl);
      }

      // (3) 커스텀 프로퍼티를 리터럴 값으로 복제 루트에 인라인 주입
      var snap = lightVarSnapshot();
      var keys = Object.keys(snap);
      if (root && root.style) {
        for (var i = 0; i < keys.length; i++) {
          root.style.setProperty(keys[i], snap[keys[i]]);
        }
      }

      // (4) 캡처 대상 자체에 라이트 톤 명시 — 다크 body 에서 상속된 밝은 글자색 차단
      if (element && element.style) {
        element.style.backgroundColor = FALLBACK_BG;
        element.style.color = snap['--text'] || FALLBACK_TEXT;
      }
      // body 도 라이트로 (복제본 body 배경이 다크로 남으면 여백이 어둡게 찍힌다)
      if (clonedDoc.body && clonedDoc.body.style) {
        clonedDoc.body.style.backgroundColor = FALLBACK_BG;
        clonedDoc.body.style.color = snap['--text'] || FALLBACK_TEXT;
      }
    } catch (e) {
      // 캡처를 막지 않는다 — 최악의 경우에도 기존 동작으로 진행
    }
  }

  /**
   * PNG/PPTX 캡처 공용 html2canvas 옵션.
   * (로컬 DOM 만 캡처하므로 CORS/foreignObject 불필요, 배경은 항상 흰색)
   * @param {number} scale  캡처 배율
   * @param {number} width  캡처 폭(CSS px)
   * @param {number} height 캡처 높이(CSS px)
   * @returns {object} html2canvas 옵션 객체
   */
  function h2cOptions(scale, width, height) {
    return {
      scale: scale,
      backgroundColor: FALLBACK_BG,
      width: width,
      height: height,
      windowWidth: width,
      windowHeight: height,
      scrollX: 0,
      scrollY: 0,
      useCORS: false,
      logging: false,
      onclone: onCloneForExport,
    };
  }

  window.ExportCapture = {
    h2cOptions: h2cOptions,
    onCloneForExport: onCloneForExport,
    collectCssText: collectCssText,
    collectVarNames: collectVarNames,
    lightVarSnapshot: lightVarSnapshot,
  };
})();
