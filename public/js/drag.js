// 태스크 바 드래그 "이동" 로직 (6단계 1/3)
// - 바(마일스톤 다이아몬드 포함)를 좌우로 끌어 시작일·종료일을 함께 이동(기간 유지).
// - 보기(일/주/월)와 무관하게 항상 '일 단위'로 스냅(이동 px ÷ 하루 폭 → 반올림).
// - 날짜 계산은 순수 함수로 분리하여 Node 단위 테스트가 가능하도록 파일 상단에 둔다.
// - 브라우저 전용 컨트롤러(포인터 이벤트·시각 피드백·저장/롤백)는 파일 하단
//   `typeof document !== 'undefined'` 블록에 모아 Node require 시 실행되지 않게 한다.

// ─────────────────────────────────────────────────────────────
// 순수 함수 (Node 테스트 가능) — DOM/브라우저에 의존하지 않음
// ─────────────────────────────────────────────────────────────

// 두 자리 0 패딩
function _pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

/**
 * 마우스 수평 이동량(px)을 '일 단위' 이동 일수로 변환한다.
 * 하루 폭(pxPerDay)으로 나눠 반올림 — 주/월 보기에서도 하루 단위 정밀 이동.
 * @param {number} dx 수평 이동 px (오른쪽 +, 왼쪽 -)
 * @param {number} pxPerDay 하루당 픽셀 폭
 * @returns {number} 이동 일수(정수). pxPerDay 가 0/음수면 0.
 */
function pxToDayShift(dx, pxPerDay) {
  if (!pxPerDay || pxPerDay <= 0) return 0;
  return Math.round(dx / pxPerDay);
}

/**
 * 'YYYY-MM-DD' 문자열에 일수를 더해 다시 'YYYY-MM-DD' 로 반환한다.
 * 로컬 자정 Date 로 계산하여 타임존 영향과 월 경계 넘김을 안전하게 처리한다.
 * @param {string} dateStr 'YYYY-MM-DD'
 * @param {number} days 더할 일수(음수 가능)
 * @returns {string} 'YYYY-MM-DD'
 */
function shiftDateStr(dateStr, days) {
  var p = String(dateStr).split('-');
  var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]) + days);
  return d.getFullYear() + '-' + _pad2(d.getMonth() + 1) + '-' + _pad2(d.getDate());
}

/**
 * 시작·종료일을 같은 일수만큼 이동한다(기간 길이 유지).
 * 마일스톤(start==end)도 그대로 함께 이동된다.
 * @param {string} startStr 시작일 'YYYY-MM-DD'
 * @param {string} endStr 종료일 'YYYY-MM-DD'
 * @param {number} dayShift 이동 일수
 * @returns {{startDate:string, endDate:string}}
 */
function computeMovedDates(startStr, endStr, dayShift) {
  return {
    startDate: shiftDateStr(startStr, dayShift),
    endDate: shiftDateStr(endStr, dayShift),
  };
}

/**
 * 'YYYY-MM-DD' → 'M/D' (툴팁 표기용)
 * @param {string} dateStr
 * @returns {string}
 */
function formatMD(dateStr) {
  var p = String(dateStr).split('-');
  return Number(p[1]) + '/' + Number(p[2]);
}

/**
 * 두 날짜 문자열 사이의 일수 차 (b - a). 로컬 자정 기준.
 * @param {string} aStr 'YYYY-MM-DD'
 * @param {string} bStr 'YYYY-MM-DD'
 * @returns {number} 일수 (b 가 뒤면 양수)
 */
function daysBetween(aStr, bStr) {
  var pa = String(aStr).split('-');
  var pb = String(bStr).split('-');
  var a = new Date(Number(pa[0]), Number(pa[1]) - 1, Number(pa[2]));
  var b = new Date(Number(pb[0]), Number(pb[1]) - 1, Number(pb[2]));
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}

/**
 * 리사이즈: 한쪽 끝만 이동한 새 날짜를 계산한다 (6단계 2/3).
 * - edge='left'  : startDate 만 변경 (endDate 고정)
 * - edge='right' : endDate 만 변경 (startDate 고정)
 * - 최소 1일(시작=종료) 보장: startDate 가 endDate 를 넘지 않도록 이동량을 클램프.
 * @param {string} startStr 시작일 'YYYY-MM-DD'
 * @param {string} endStr 종료일 'YYYY-MM-DD'
 * @param {number} dayShift 요청 이동 일수(음수 가능)
 * @param {string} edge 'left' | 'right'
 * @returns {{startDate:string, endDate:string, dayShift:number}} dayShift 는 클램프 적용 후 실제 이동량
 */
function computeResizedDates(startStr, endStr, dayShift, edge) {
  var dur = daysBetween(startStr, endStr); // 기간 일수 (시작=종료면 0)
  var s;
  if (edge === 'left') {
    s = Math.min(dayShift, dur); // 시작일이 종료일을 넘지 못함
    return { startDate: shiftDateStr(startStr, s), endDate: endStr, dayShift: s };
  }
  s = Math.max(dayShift, -dur);  // 종료일이 시작일보다 앞서지 못함
  return { startDate: startStr, endDate: shiftDateStr(endStr, s), dayShift: s };
}

/**
 * 순서 변경: 드롭 위치의 새 order 값을 계산한다 (6단계 3/3).
 * - 맨 앞: 첫 형제 order - 1 / 맨 뒤: 마지막 형제 order + 1
 * - 중간: 이웃 두 형제 order 의 중간값. 이웃 간격이 1e-9 미만이면
 *   중간값으로 구분이 불가능하므로 renormalize(0,1,2,... 재부여) 필요 표시.
 * @param {number[]} orders 자신을 제외한 형제들의 order 배열 (화면 표시 순서)
 * @param {number} insertIndex 삽입 위치 (0=맨 앞, orders.length=맨 뒤)
 * @returns {{order:number, renormalize:boolean}}
 */
function computeInsertOrder(orders, insertIndex) {
  var EPS = 1e-9;
  if (!orders || orders.length === 0) {
    return { order: 0, renormalize: false }; // 형제 없음 — 아무 값이나 무방
  }
  if (insertIndex <= 0) {
    return { order: orders[0] - 1, renormalize: false }; // 맨 앞
  }
  if (insertIndex >= orders.length) {
    return { order: orders[orders.length - 1] + 1, renormalize: false }; // 맨 뒤
  }
  var prev = orders[insertIndex - 1];
  var next = orders[insertIndex];
  // 간격이 너무 좁으면(동일 order 포함) 중간값으로 순서를 표현할 수 없음
  return { order: (prev + next) / 2, renormalize: (next - prev) < EPS };
}

/**
 * 좌표점 배열을 SVG path 문자열로 변환한다 (연속 중복점 제거).
 * @param {Array.<Array.<number>>} pts [[x,y], ...]
 * @returns {string} 예: 'M 10 18 L 20 18 L 80 18'
 */
function pointsToPath(pts) {
  var out = [];
  var prev = null;
  for (var i = 0; i < pts.length; i++) {
    var p = pts[i];
    if (prev && p[0] === prev[0] && p[1] === prev[1]) continue; // 같은 점 반복 스킵
    out.push((out.length === 0 ? 'M' : 'L') + ' ' + p[0] + ' ' + p[1]);
    prev = p;
  }
  return out.join(' ');
}

/**
 * 의존성(FS) 화살표 SVG path 문자열을 계산한다 (7단계, 순수 함수).
 * 선행 태스크의 오른쪽 끝(fromX,fromY) → 후행 태스크의 왼쪽 시작(toX,toY) 을
 * 직각 꺾임(elbow)으로 잇는다. 화살촉은 path 끝(후행 시작)에 marker 로 붙는다.
 *  - 정방향(후행 시작이 선행 끝+stub 보다 오른쪽):
 *      오른쪽으로 stub → 세로로 후행 행까지 → 후행 시작 x 까지 가로 → 화살촉
 *  - 역방향(후행 시작이 더 왼쪽 — 감아 돌기):
 *      오른쪽 stub → 두 행 사이(midY)로 세로 → 왼쪽으로 → 후행 시작 왼쪽 stub → 세로 → 화살촉
 * 좌표는 정수로 반올림해 path 문자열을 안정적으로 만든다.
 * @param {number} fromX 선행 끝 x
 * @param {number} fromY 선행 중심 y
 * @param {number} toX 후행 시작 x
 * @param {number} toY 후행 중심 y
 * @param {number} [stub=10] 꺾임 여유 px
 * @returns {string} SVG path d 문자열
 */
function buildDependencyPath(fromX, fromY, toX, toY, stub) {
  var s = (stub == null) ? 10 : stub;
  var fx = Math.round(fromX), fy = Math.round(fromY);
  var tx = Math.round(toX), ty = Math.round(toY);
  var pts;
  if (tx > fx + s) {
    // 정방향: → stub → ↕ → →
    pts = [[fx, fy], [fx + s, fy], [fx + s, ty], [tx, ty]];
  } else {
    // 역방향: → stub → ↕(행 사이) → ← → ↕ → →
    var midY = Math.round((fy + ty) / 2);
    pts = [[fx, fy], [fx + s, fy], [fx + s, midY], [tx - s, midY], [tx - s, ty], [tx, ty]];
  }
  return pointsToPath(pts);
}

// ─────────────────────────────────────────────────────────────
// 줌(8단계) 순수 함수 — 배율 단계·앵커 스크롤 보정
// ─────────────────────────────────────────────────────────────

// 줌 배율 단계 (50% ~ 200%). 인덱스로 관리하며 한계에서 클램프한다.
var ZOOM_STEPS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2];

/**
 * 줌 인덱스를 유효 범위 [0, ZOOM_STEPS.length-1] 로 클램프한다.
 * 숫자가 아니면 100%(=1) 의 인덱스를 반환한다.
 * @param {number} i 요청 인덱스
 * @returns {number} 클램프된 정수 인덱스
 */
function clampZoomIndex(i) {
  var def = ZOOM_STEPS.indexOf(1);
  if (typeof i !== 'number' || !isFinite(i)) return def;
  var n = Math.round(i);
  if (n < 0) return 0;
  if (n > ZOOM_STEPS.length - 1) return ZOOM_STEPS.length - 1;
  return n;
}

/**
 * 현재 인덱스에서 한 단계 이동한 새 인덱스 (한계에서 멈춤).
 * @param {number} cur 현재 인덱스
 * @param {number} dir +1(확대) | -1(축소)
 * @returns {number}
 */
function nextZoomIndex(cur, dir) {
  return clampZoomIndex(clampZoomIndex(cur) + (dir > 0 ? 1 : -1));
}

/**
 * 줌 전후 하루 폭 변화에 맞춰, 뷰포트의 앵커 지점(anchorViewX)에 있던
 * 날짜가 줌 후에도 같은 화면 위치에 오도록 새 scrollLeft 를 계산한다.
 *   앵커의 콘텐츠 좌표(일 단위) = (scrollLeft + anchorViewX) / oldPx
 *   새 scrollLeft = 일 단위 × newPx − anchorViewX  (0 미만 클램프)
 * @param {number} scrollLeft 줌 전 scrollLeft
 * @param {number} anchorViewX 앵커의 뷰포트 내 x (중앙 앵커면 viewportW/2)
 * @param {number} oldPx 줌 전 하루 폭
 * @param {number} newPx 줌 후 하루 폭
 * @returns {number} 새 scrollLeft (px)
 */
function computeAnchorScroll(scrollLeft, anchorViewX, oldPx, newPx) {
  if (!oldPx || oldPx <= 0 || !newPx || newPx <= 0) return scrollLeft;
  var days = (scrollLeft + anchorViewX) / oldPx; // 앵커 지점의 날짜(소수 포함)
  var s = days * newPx - anchorViewX;
  return s < 0 ? 0 : s;
}

/**
 * 특정 콘텐츠 x 좌표(targetX)가 뷰포트 중앙에 오도록 하는 scrollLeft.
 * @param {number} targetX 콘텐츠 좌표 x (예: 오늘선 위치)
 * @param {number} viewportW 뷰포트 너비
 * @returns {number} scrollLeft (0 미만 클램프)
 */
function computeCenterScroll(targetX, viewportW) {
  var s = targetX - viewportW / 2;
  return s < 0 ? 0 : s;
}

// Node(테스트) 환경에서 순수 함수 검증 가능하도록 내보내기
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    pxToDayShift: pxToDayShift,
    shiftDateStr: shiftDateStr,
    computeMovedDates: computeMovedDates,
    formatMD: formatMD,
    daysBetween: daysBetween,
    computeResizedDates: computeResizedDates,
    computeInsertOrder: computeInsertOrder,
    pointsToPath: pointsToPath,
    buildDependencyPath: buildDependencyPath,
    ZOOM_STEPS: ZOOM_STEPS,
    clampZoomIndex: clampZoomIndex,
    nextZoomIndex: nextZoomIndex,
    computeAnchorScroll: computeAnchorScroll,
    computeCenterScroll: computeCenterScroll,
  };
}

// ─────────────────────────────────────────────────────────────
// 브라우저 전용 컨트롤러 — Node require 시에는 실행되지 않음
// ─────────────────────────────────────────────────────────────
if (typeof document !== 'undefined') {
  (function () {
    'use strict';

    // 이동으로 간주할 최소 픽셀 (이 미만은 클릭으로 처리 — 수정 패널 열기)
    var CLICK_THRESHOLD = 5;

    // gantt.js 가 렌더링할 때마다 갱신해 주는 현재 렌더 컨텍스트
    var ctx = { pxPerDay: 40 };

    // 진행 중인 드래그 상태 (없으면 null)
    var drag = null;

    var boundBody = false; // timeline-body 위임 바인딩 1회 보장

    // ── 토스트 (우상단, 실패 시 빨강, 3초 후 사라짐) ──
    function ensureToastHost() {
      var host = document.getElementById('toast-host');
      if (!host) {
        host = document.createElement('div');
        host.id = 'toast-host';
        host.className = 'toast-host';
        document.body.appendChild(host);
      }
      return host;
    }

    // ── 의존성 화살표 레이어 흐리게/복구 (7단계) ──
    // 바 드래그 중에는 화살표가 옛 위치를 가리키므로 흐리게 했다가,
    // 드롭 후 재렌더(reload)에서 새 레이어가 그려지며 자연히 복구된다.
    // 제자리/취소 등 재렌더가 없는 경로에서는 cleanupVisuals 가 복구한다.
    function setDepLayerOpacity(v) {
      var layer = document.getElementById('dep-layer');
      if (layer) layer.style.opacity = v;
    }

    function showToast(message) {
      var host = ensureToastHost();
      var el = document.createElement('div');
      el.className = 'toast toast--error';
      el.setAttribute('role', 'alert');
      el.textContent = message;
      host.appendChild(el);
      // 다음 프레임에 표시 클래스 → 페이드 인
      requestAnimationFrame(function () { el.classList.add('is-shown'); });
      // 3초 후 페이드 아웃 & 제거
      setTimeout(function () {
        el.classList.remove('is-shown');
        setTimeout(function () {
          if (el.parentNode) el.parentNode.removeChild(el);
        }, 250);
      }, 3000);
    }

    // ── 서버로 날짜 이동 저장 (PUT, 부분 수정) ──
    async function saveDates(taskId, startDate, endDate) {
      var res = await fetch('/api/tasks/' + encodeURIComponent(taskId), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startDate: startDate, endDate: endDate }),
      });
      var data = null;
      try { data = await res.json(); } catch (e) { /* 본문 없음 */ }
      if (!res.ok) {
        throw new Error((data && data.error) ? data.error : ('요청 실패 (HTTP ' + res.status + ')'));
      }
      return data;
    }

    // ── 드래그 시작 ──
    function onPointerDown(e) {
      if (e.button !== undefined && e.button !== 0) return; // 좌클릭만
      if (drag) return;                                     // 이미 드래그 중
      var el = e.target.closest && e.target.closest('.bar, .milestone');
      if (!el) return;
      var taskId = el.getAttribute('data-task-id');
      if (!taskId) return;

      // 리사이즈 핸들 위에서 시작하면 리사이즈 모드 (마일스톤에는 핸들이 없음 → 항상 이동)
      var handle = e.target.closest && e.target.closest('.bar__handle');

      e.preventDefault(); // 텍스트 선택/기본 드래그 방지

      drag = {
        el: el,
        taskId: taskId,
        // 'move' | 'resize-left'(시작일만) | 'resize-right'(종료일만)
        mode: handle ? ('resize-' + handle.getAttribute('data-edge')) : 'move',
        handleEl: handle || null,
        startDate: el.getAttribute('data-start'),
        endDate: el.getAttribute('data-end'),
        startX: e.clientX,
        origLeft: el.offsetLeft,   // 원래 위치(px, body 좌표)
        origTop: el.offsetTop,
        origW: el.offsetWidth,
        origH: el.offsetHeight,
        dayShift: 0,
        moved: false,              // 임계값 초과 여부
        ghost: null,
        tooltip: null,
      };

      // 포인터 캡처: 드래그 중 커서가 바를 벗어나도 이벤트 수신
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* 미지원 무시 */ }
      el.addEventListener('pointermove', onPointerMove);
      el.addEventListener('pointerup', onPointerUp);
      el.addEventListener('pointercancel', onPointerCancel);
    }

    // 임계값을 처음 넘는 순간 시각 피드백 요소(고스트/툴팁)를 준비한다.
    function beginVisuals() {
      var body = document.getElementById('timeline-body');
      if (!body) return;

      // 원래 위치 잔상(점선 외곽선)
      var ghost = document.createElement('div');
      ghost.className = 'drag-ghost';
      ghost.style.left = drag.origLeft + 'px';
      ghost.style.top = drag.origTop + 'px';
      ghost.style.width = drag.origW + 'px';
      ghost.style.height = drag.origH + 'px';
      body.appendChild(ghost);
      drag.ghost = ghost;

      // 임시 날짜 툴팁
      var tip = document.createElement('div');
      tip.className = 'drag-tooltip';
      body.appendChild(tip);
      drag.tooltip = tip;

      setDepLayerOpacity('0.3');             // 의존선 흐리게

      drag.el.classList.add('is-dragging'); // 반투명
      if (drag.mode === 'move') {
        document.body.classList.add('is-drag-active');   // 커서 grabbing
      } else {
        document.body.classList.add('is-resize-active'); // 커서 ew-resize
        // 잡고 있는 쪽 핸들 하이라이트
        if (drag.handleEl) drag.handleEl.classList.add('is-active');
      }
    }

    // 현재 모드·이동량 기준의 최종 날짜 계산 (move: 양쪽 함께 / resize: 한쪽만)
    function currentDates() {
      if (drag.mode === 'move') {
        return computeMovedDates(drag.startDate, drag.endDate, drag.dayShift);
      }
      var edge = drag.mode === 'resize-left' ? 'left' : 'right';
      // dayShift 는 이미 클램프된 값이라 재클램프해도 결과 동일
      return computeResizedDates(drag.startDate, drag.endDate, drag.dayShift, edge);
    }

    // 툴팁 내용·위치 갱신
    function updateTooltip(newLeft, moved) {
      if (!drag.tooltip) return;
      var m = currentDates();
      drag.tooltip.textContent = formatMD(m.startDate) + ' ~ ' + formatMD(m.endDate);
      // 바 위쪽에 배치 (body 좌표)
      drag.tooltip.style.left = newLeft + 'px';
      drag.tooltip.style.top = (drag.origTop - 24) + 'px';
    }

    // ── 드래그 이동/리사이즈 ──
    function onPointerMove(e) {
      if (!drag) return;
      var dx = e.clientX - drag.startX;

      if (!drag.moved && Math.abs(dx) >= CLICK_THRESHOLD) {
        drag.moved = true;
        beginVisuals();
      }
      if (!drag.moved) return; // 아직 클릭 범위 — 아무 것도 안 함

      // 항상 '일 단위' 스냅 (재렌더 없이 left/width 만 갱신)
      var rawShift = pxToDayShift(dx, ctx.pxPerDay);
      var newLeft = drag.origLeft;

      if (drag.mode === 'move') {
        // 이동: 시작·종료 함께 (기간 유지)
        drag.dayShift = rawShift;
        newLeft = drag.origLeft + drag.dayShift * ctx.pxPerDay;
        drag.el.style.left = newLeft + 'px';
      } else if (drag.mode === 'resize-left') {
        // 왼쪽 핸들: startDate 만 변경 — 최소 1일(시작=종료) 클램프
        drag.dayShift = computeResizedDates(drag.startDate, drag.endDate, rawShift, 'left').dayShift;
        newLeft = drag.origLeft + drag.dayShift * ctx.pxPerDay;
        drag.el.style.left = newLeft + 'px';
        drag.el.style.width = (drag.origW - drag.dayShift * ctx.pxPerDay) + 'px';
      } else {
        // 오른쪽 핸들: endDate 만 변경 — 최소 1일 클램프
        drag.dayShift = computeResizedDates(drag.startDate, drag.endDate, rawShift, 'right').dayShift;
        drag.el.style.width = (drag.origW + drag.dayShift * ctx.pxPerDay) + 'px';
      }
      updateTooltip(newLeft, true);
    }

    // 시각 피드백 정리 (고스트/툴팁 제거, 클래스 원복)
    function cleanupVisuals() {
      if (!drag) return;
      if (drag.ghost && drag.ghost.parentNode) drag.ghost.parentNode.removeChild(drag.ghost);
      if (drag.tooltip && drag.tooltip.parentNode) drag.tooltip.parentNode.removeChild(drag.tooltip);
      setDepLayerOpacity('');                // 의존선 복구(재렌더 없을 때 대비)
      drag.el.classList.remove('is-dragging');
      document.body.classList.remove('is-drag-active');
      document.body.classList.remove('is-resize-active');
      if (drag.handleEl) drag.handleEl.classList.remove('is-active');
    }

    // 바를 원래 위치·크기로 되돌린다 (이동/리사이즈 공통 롤백)
    function restoreOriginal(d) {
      d.el.style.left = d.origLeft + 'px';
      d.el.style.width = d.origW + 'px';
    }

    // 리스너 해제
    function detach(el, pointerId) {
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointercancel', onPointerCancel);
      try { el.releasePointerCapture(pointerId); } catch (err) { /* 무시 */ }
    }

    // ── 드롭(저장) ──
    async function onPointerUp(e) {
      if (!drag) return;
      var d = drag;
      detach(d.el, e.pointerId);

      // 클릭(임계값 미만): 이동 취소 → 수정 패널 열기 (기존 행 클릭과 동일 동작)
      if (!d.moved) {
        drag = null;
        if (window.CrudUI && window.CrudUI.editTask) window.CrudUI.editTask(d.taskId);
        return;
      }

      // 이동량 0 (제자리): 저장 없이 정리
      if (d.dayShift === 0) {
        cleanupVisuals();
        restoreOriginal(d);
        drag = null;
        return;
      }

      var next = currentDates(); // 모드(이동/리사이즈)에 맞는 최종 날짜
      cleanupVisuals();
      drag = null;

      try {
        await saveDates(d.taskId, next.startDate, next.endDate);
        // 성공: 데이터 재로딩 → 재렌더링 (바 위치/크기가 새 날짜로 확정됨)
        if (window.GanttApp && window.GanttApp.reload) await window.GanttApp.reload();
      } catch (ex) {
        // 실패: 원래 위치·크기로 되돌리고 빨간 토스트 표시
        restoreOriginal(d);
        showToast(ex.message || '변경을 저장하지 못했습니다.');
      }
    }

    // ── 취소(포인터 캔슬) ──
    function onPointerCancel(e) {
      if (!drag) return;
      var d = drag;
      detach(d.el, e.pointerId);
      cleanupVisuals();
      restoreOriginal(d); // 원래 위치·크기
      drag = null;
    }

    // ═════════════════════════════════════════════════════════
    // 좌측 목록 세로 드래그 순서 변경 (6단계 3/3)
    // - 같은 프로젝트 + 같은 부모(parentId)의 형제끼리만 순서 교환.
    // - 5px(세로) 미만은 클릭으로 간주 → 기존 행 클릭(수정 패널) 동작 유지.
    // ═════════════════════════════════════════════════════════

    var reorder = null;      // 진행 중인 순서 변경 드래그 상태
    var boundLeft = false;   // 좌측 목록 위임 바인딩 1회 보장
    var suppressClick = false; // 드래그 직후 발생하는 click 1회 차단용

    // 서버로 order 저장 (PUT 부분 수정)
    async function saveOrder(taskId, order) {
      var res = await fetch('/api/tasks/' + encodeURIComponent(taskId), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: order }),
      });
      var data = null;
      try { data = await res.json(); } catch (e) { /* 본문 없음 */ }
      if (!res.ok) {
        throw new Error((data && data.error) ? data.error : ('요청 실패 (HTTP ' + res.status + ')'));
      }
      return data;
    }

    // 특정 태스크의 자손 id 집합 (crud.js 전역 getDescendantIds 재사용)
    function descendantSet(taskId) {
      var set = {};
      if (typeof getDescendantIds === 'function' && window.GanttApp) {
        getDescendantIds(window.GanttApp.getState().tasks, taskId)
          .forEach(function (id) { set[id] = true; });
      }
      return set;
    }

    // ── 순서 변경 드래그 시작 ──
    function onRowPointerDown(e) {
      if (e.button !== undefined && e.button !== 0) return; // 좌클릭만
      if (reorder || drag) return;                          // 다른 드래그 진행 중
      // 삭제(🗑) 등 아이콘 버튼에서는 드래그 시작하지 않음
      if (e.target.closest && e.target.closest('.icon-btn')) return;
      var rowEl = e.target.closest && e.target.closest('.row[data-task-id]');
      if (!rowEl) return;
      var body = document.getElementById('gantt-left-body');
      if (!body) return;

      var taskId = rowEl.getAttribute('data-task-id');
      var projectId = rowEl.getAttribute('data-project-id');
      var parentKey = rowEl.getAttribute('data-parent-id') || '';

      // 자기 자손 집합 (형제 후보·반투명 표시에서 함께 취급)
      var desc = descendantSet(taskId);

      // 형제 행: 같은 프로젝트 + 같은 부모, 자기 자신·자손 제외 (표시 순서대로)
      var allRows = Array.prototype.slice.call(body.querySelectorAll('.row[data-task-id]'));
      var siblings = allRows.filter(function (r) {
        var id = r.getAttribute('data-task-id');
        return id !== taskId && !desc[id] &&
          r.getAttribute('data-project-id') === projectId &&
          (r.getAttribute('data-parent-id') || '') === parentKey;
      });
      if (siblings.length === 0) return; // 바꿀 상대가 없음 — 클릭 동작만 유지

      // 삽입 슬롯 y 좌표: i<n 은 형제[i] 행의 위쪽, i=n 은 마지막 형제 서브트리의 아래쪽
      var slots = [];
      siblings.forEach(function (r) { slots.push(r.offsetTop); });
      var lastSib = siblings[siblings.length - 1];
      var lastId = lastSib.getAttribute('data-task-id');
      var lastDesc = descendantSet(lastId);
      var bottom = lastSib.offsetTop + lastSib.offsetHeight;
      allRows.forEach(function (r) {
        var id = r.getAttribute('data-task-id');
        if (id === lastId || lastDesc[id]) {
          var b = r.offsetTop + r.offsetHeight;
          if (b > bottom) bottom = b;
        }
      });
      slots.push(bottom);

      // 자기 자신 + 자손 행 (반투명 처리 + 유효 구역 계산)
      var selfRows = allRows.filter(function (r) {
        var id = r.getAttribute('data-task-id');
        return id === taskId || desc[id];
      });
      var selfBottom = 0;
      selfRows.forEach(function (r) {
        var b = r.offsetTop + r.offsetHeight;
        if (b > selfBottom) selfBottom = b;
      });

      // 유효 드롭 구역: 형제 블록 + 자기 서브트리 범위 (±18px 여유)
      // 구역 밖(다른 프로젝트/다른 부모 위치)에서는 삽입선을 숨기고 드롭을 무시한다.
      var zoneTop = Math.min(slots[0], rowEl.offsetTop) - 18;
      var zoneBottom = Math.max(slots[slots.length - 1], selfBottom) + 18;

      // 현재 위치: 자기보다 위에 표시된 형제 수
      var selfTop = rowEl.offsetTop;
      var currentIndex = siblings.filter(function (r) { return r.offsetTop < selfTop; }).length;

      reorder = {
        rowEl: rowEl,
        taskId: taskId,
        siblings: siblings,
        selfRows: selfRows,
        slots: slots,
        zoneTop: zoneTop,
        zoneBottom: zoneBottom,
        currentIndex: currentIndex,
        targetIndex: null,   // 유효 드롭 위치 (null=무효)
        startY: e.clientY,
        moved: false,
        line: null,
      };

      try { rowEl.setPointerCapture(e.pointerId); } catch (err) { /* 미지원 무시 */ }
      rowEl.addEventListener('pointermove', onRowPointerMove);
      rowEl.addEventListener('pointerup', onRowPointerUp);
      rowEl.addEventListener('pointercancel', onRowPointerCancel);
    }

    // 임계값 초과 시 시각 피드백 준비 (반투명 + 삽입선 요소)
    function beginReorderVisuals() {
      var body = document.getElementById('gantt-left-body');
      reorder.selfRows.forEach(function (r) { r.classList.add('is-reorder-source'); });
      document.body.classList.add('is-reorder-active');
      var line = document.createElement('div');
      line.className = 'reorder-line';
      line.style.display = 'none';
      body.appendChild(line);
      reorder.line = line;
    }

    // ── 순서 변경 드래그 이동 ──
    function onRowPointerMove(e) {
      if (!reorder) return;
      var dy = e.clientY - reorder.startY;

      if (!reorder.moved && Math.abs(dy) >= CLICK_THRESHOLD) {
        reorder.moved = true;
        beginReorderVisuals();
      }
      if (!reorder.moved) return;

      // 포인터 y → 좌측 목록 콘텐츠 좌표
      var body = document.getElementById('gantt-left-body');
      var rect = body.getBoundingClientRect();
      var y = e.clientY - rect.top + body.scrollTop;

      // 유효 구역 밖(다른 프로젝트/부모 등) → 삽입선 숨김 + 드롭 무효
      if (y < reorder.zoneTop || y > reorder.zoneBottom) {
        reorder.targetIndex = null;
        if (reorder.line) reorder.line.style.display = 'none';
        return;
      }

      // 형제 행 중간점 기준으로 삽입 위치 결정
      var idx = 0;
      reorder.siblings.forEach(function (r) {
        if (r.offsetTop + r.offsetHeight / 2 < y) idx++;
      });
      reorder.targetIndex = idx;

      // 제자리(현재 위치와 동일)면 선을 숨겨 no-op 임을 표시
      if (idx === reorder.currentIndex) {
        if (reorder.line) reorder.line.style.display = 'none';
        return;
      }
      if (reorder.line) {
        reorder.line.style.display = 'block';
        reorder.line.style.top = (reorder.slots[idx] - 1) + 'px';
      }
    }

    // 시각 피드백 정리
    function cleanupReorderVisuals() {
      if (!reorder) return;
      reorder.selfRows.forEach(function (r) { r.classList.remove('is-reorder-source'); });
      document.body.classList.remove('is-reorder-active');
      if (reorder.line && reorder.line.parentNode) reorder.line.parentNode.removeChild(reorder.line);
    }

    // 리스너 해제
    function detachRow(el, pointerId) {
      el.removeEventListener('pointermove', onRowPointerMove);
      el.removeEventListener('pointerup', onRowPointerUp);
      el.removeEventListener('pointercancel', onRowPointerCancel);
      try { el.releasePointerCapture(pointerId); } catch (err) { /* 무시 */ }
    }

    // ── 드롭(순서 저장) ──
    async function onRowPointerUp(e) {
      if (!reorder) return;
      var r = reorder;
      detachRow(r.rowEl, e.pointerId);

      // 클릭(임계값 미만): 아무 것도 안 함 → 이어지는 click 이 수정 패널을 연다
      if (!r.moved) {
        cleanupReorderVisuals();
        reorder = null;
        return;
      }

      // 드래그였음 — 브라우저가 이어서 발생시키는 click 1회 차단
      suppressClick = true;
      setTimeout(function () { suppressClick = false; }, 0);

      var tIdx = r.targetIndex;
      cleanupReorderVisuals();
      reorder = null;

      // 무효 위치(구역 밖) 또는 제자리 → 저장 없음
      if (tIdx == null || tIdx === r.currentIndex) return;

      // 형제들의 현재 order 값 (표시 순서대로, null 은 0 취급)
      var tasks = window.GanttApp ? window.GanttApp.getState().tasks : [];
      var byId = {};
      tasks.forEach(function (t) { byId[t.id] = t; });
      var orders = r.siblings.map(function (row) {
        var t = byId[row.getAttribute('data-task-id')];
        return (t && typeof t.order === 'number' && isFinite(t.order)) ? t.order : 0;
      });

      var calc = computeInsertOrder(orders, tIdx);
      try {
        if (calc.renormalize) {
          // 간격 부족 → 형제 전체를 새 표시 순서대로 0,1,2,... 재부여 (순차 PUT)
          var ids = r.siblings.map(function (row) { return row.getAttribute('data-task-id'); });
          ids.splice(tIdx, 0, r.taskId);
          for (var i = 0; i < ids.length; i++) {
            await saveOrder(ids[i], i);
          }
        } else {
          await saveOrder(r.taskId, calc.order);
        }
        if (window.GanttApp && window.GanttApp.reload) await window.GanttApp.reload();
      } catch (ex) {
        // 실패: 재로딩으로 화면을 서버 상태로 되돌리고 토스트 표시
        showToast(ex.message || '순서를 저장하지 못했습니다.');
        if (window.GanttApp && window.GanttApp.reload) await window.GanttApp.reload();
      }
    }

    // ── 취소(포인터 캔슬) ──
    function onRowPointerCancel(e) {
      if (!reorder) return;
      var r = reorder;
      detachRow(r.rowEl, e.pointerId);
      cleanupReorderVisuals();
      reorder = null;
    }

    // 좌측 목록 위임 바인딩 (1회) — 드래그 직후 click 차단 리스너 포함
    function bindLeftList() {
      if (boundLeft) return;
      var body = document.getElementById('gantt-left-body');
      if (!body) return;
      boundLeft = true;
      body.addEventListener('pointerdown', onRowPointerDown);
      // capture 단계에서 가로채 gantt.js 의 클릭 위임(수정 패널)보다 먼저 차단
      body.addEventListener('click', function (e) {
        if (suppressClick) {
          suppressClick = false;
          e.stopPropagation();
          e.preventDefault();
        }
      }, true);
    }

    // gantt.js 가 렌더링 직후 호출: 현재 pxPerDay 등 컨텍스트 갱신 + 위임 바인딩
    function updateContext(next) {
      if (next && typeof next.pxPerDay === 'number' && next.pxPerDay > 0) {
        ctx.pxPerDay = next.pxPerDay;
      }
      if (!boundBody) {
        var body = document.getElementById('timeline-body');
        if (body) {
          // 위임: timeline-body 요소는 재렌더 사이에도 유지되므로 1회만 바인딩
          body.addEventListener('pointerdown', onPointerDown);
          boundBody = true;
        }
      }
      bindLeftList(); // 좌측 목록 순서 변경 바인딩 (1회)
    }

    // gantt.js 및 디버깅용 공개 API
    window.GanttDrag = {
      updateContext: updateContext,
      showToast: showToast,
    };
  })();
}
