// 모달/패널 공용 Tab 트랩 유틸 (12단계: 키보드 포커스)
// - 컨테이너(모달·패널 최상위 요소) 안에서만 Tab/Shift+Tab 이 순환하도록 가둔다.
// - 열기 전 포커스였던 요소를 기억해뒀다가 닫을 때(deactivate) 되돌려준다.
// - 열릴 때 컨테이너 내부 첫 포커스 가능 요소(또는 지정된 요소)로 포커스를 옮긴다.
//
// 사용법:
//   var trap = window.FocusTrap.activate(containerEl[, { initialFocus: el }]);
//   ... (모달이 열려있는 동안) ...
//   trap.deactivate();   // Esc/배경클릭/취소버튼 등 모든 닫기 경로에서 호출
//
// 순수 DOM API만 사용하며 이 프로젝트 전반의 IIFE 패턴을 따른다.
(function () {
  'use strict';

  // Tab 으로 도달 가능한 요소 후보 셀렉터 (표준적인 포커스 가능 요소 집합)
  var FOCUSABLE_SELECTOR = [
    'a[href]',
    'button:not([disabled])',
    'textarea:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  // 컨테이너 내부에서 실제로 보이는(화면에 렌더링된) 포커스 가능 요소만 추린다.
  // (hidden 속성/부모 hidden 등으로 offsetParent 가 없는 요소는 제외)
  function getFocusable(container) {
    var nodes = container.querySelectorAll(FOCUSABLE_SELECTOR);
    var result = [];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.offsetParent !== null || el === document.activeElement) {
        result.push(el);
      }
    }
    return result;
  }

  /**
   * 지정 컨테이너에 Tab 트랩을 건다.
   * @param {HTMLElement} container 트랩을 걸 최상위 요소(모달/패널)
   * @param {{initialFocus?: HTMLElement}} [opts]
   * @returns {{deactivate: function(): void}}
   */
  function activate(container, opts) {
    opts = opts || {};
    var previouslyFocused = document.activeElement;

    function onKeydown(e) {
      if (e.key !== 'Tab') return;
      var focusable = getFocusable(container);
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      var active = document.activeElement;

      if (e.shiftKey) {
        // Shift+Tab: 첫 요소(또는 트랩 밖)에서 마지막 요소로 순환
        if (active === first || !container.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        // Tab: 마지막 요소(또는 트랩 밖)에서 첫 요소로 순환
        if (active === last || !container.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    // capture 단계에서 걸어 컨테이너 내부 어느 요소가 포커스를 가지고 있어도 감지되게 한다.
    document.addEventListener('keydown', onKeydown, true);

    // 초기 포커스 이동: 지정된 요소 우선, 없으면 내부 첫 포커스 가능 요소
    var initial = opts.initialFocus || getFocusable(container)[0];
    if (initial && typeof initial.focus === 'function') {
      initial.focus();
    }

    return {
      deactivate: function () {
        document.removeEventListener('keydown', onKeydown, true);
        if (previouslyFocused && typeof previouslyFocused.focus === 'function' &&
            document.contains(previouslyFocused)) {
          previouslyFocused.focus();
        }
      },
    };
  }

  window.FocusTrap = { activate: activate };
})();
