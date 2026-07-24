// PPTX 출력 (11단계 → 13단계 확장) — PptxGenJS 로컬 번들(public/vendor)로 PowerPoint 저장
//
// 13단계에서 사용자가 모달에서 고르는 항목이 3가지가 되었다:
//   1) 차트 표현  image(기본, 이 파일의 캡처 경로) / shapes(pptx-shapes.js 의 네이티브 도형)
//   2) 레이아웃   fit / split   (구 summary 는 제거 — 아래 3) 으로 흡수)
//   3) 태스크 목록 표 포함 체크박스 → pptx-shapes.js 의 addTaskTableSlides
// 이 파일은 "이미지 방식 캡처 + 제목 슬라이드 + 전체 오케스트레이션"을 담당하고,
// 도형 그리기와 표 만들기는 pptx-shapes.js 가 전담한다.
//
// - 순수 함수(슬라이드 구성 계획·이미지 배치 좌표·상태 라벨·요약표 데이터)는 파일 상단에
//   두고 Node 테스트에서 require 할 수 있게 파일 끝에서 module.exports 한다 (png.js/scope.js 패턴).
// - 브라우저 UI(드롭다운 "PPTX 저장" → 범위/레이아웃 선택 → 오프스크린 캡처 → pptx 생성)는
//   하단 typeof document 블록에 둔다.
// - 오프스크린 캡처는 png.js buildProjectCapture 의 로직(범례 포함·16384px 처리·기간 분할)을
//   참고해 자체 구현한다. png.js 의 헬퍼는 IIFE 내부라 전역 접근 불가하기 때문이다.
//   (png.js 자체는 수정하지 않는다 — 이미 검증·커밋된 파일)

// ─────────────────────────────────────────────────────────────
// 상수
// ─────────────────────────────────────────────────────────────

// LAYOUT_WIDE (16:9) 슬라이드 크기 (인치)
var SLIDE_W_IN = 13.333;
var SLIDE_H_IN = 7.5;
// 차트 슬라이드 상단 제목이 차지할 세로 공간 (인치) — 이미지는 이 아래에 배치
var TITLE_BAND_IN = 0.6;
// 이미지 여백 (인치)
var IMG_MARGIN_IN = 0.35;
// 브라우저 캔버스 한 변 최대 px (png.js MAX_CANVAS 와 동일 값)
var PPTX_MAX_CANVAS = 16384;

// 상태 코드 → 영문+한국어 병기 라벨 (HANDOFF 5종: plan/setup/ongoing/complete/delayed)
var PPTX_STATUS_LABELS = {
  plan: 'Plan (계획)',
  setup: 'Set up (준비)',
  ongoing: 'Ongoing (진행)',
  complete: 'Complete (완료)',
  delayed: 'Delayed (지연)',
};
// 상태 색 (요약표 상태 셀 배경에 선택적으로 사용) — 화면/범례와 동일
var PPTX_STATUS_COLORS = {
  plan: '9CA3AF',
  setup: '8B5CF6',
  ongoing: '3B82F6',
  complete: '22C55E',
  delayed: 'EF4444',
};

// ─────────────────────────────────────────────────────────────
// 순수 함수 (Node 테스트 대상 — DOM/라이브러리 접근 없음, 숫자/문자/객체만)
// ─────────────────────────────────────────────────────────────

/**
 * 상태 코드를 "영문 (한국어)" 병기 라벨로 바꾼다. 알 수 없는 값은 그대로 돌려준다.
 * @param {string} status 'plan'|'setup'|'ongoing'|'complete'|'delayed'
 * @returns {string}
 */
function statusLabelKo(status) {
  return PPTX_STATUS_LABELS[status] || String(status == null ? '' : status);
}

/**
 * 이미지를 슬라이드 안에 "비율 유지로 최대한 크게" 배치할 좌표·크기(인치)를 계산한다.
 * availW/availH(여백 제외 영역)에 이미지 종횡비를 맞춰 넣고 가운데 정렬한다.
 * 반환 좌표는 슬라이드 원점 기준(인치). 이미지 픽셀이 비정상이면 여백 상자를 돌려준다.
 * @param {number} imgWpx 이미지 실제 가로 px
 * @param {number} imgHpx 이미지 실제 세로 px
 * @param {number} slideW 슬라이드 가로(인치)
 * @param {number} slideH 슬라이드 세로(인치)
 * @param {number} margin 사방 여백(인치)
 * @returns {{x:number, y:number, w:number, h:number}}
 */
function fitImageBox(imgWpx, imgHpx, slideW, slideH, margin) {
  var availW = slideW - 2 * margin;
  var availH = slideH - 2 * margin;
  if (!(imgWpx > 0) || !(imgHpx > 0) || availW <= 0 || availH <= 0) {
    return { x: margin, y: margin, w: Math.max(0, availW), h: Math.max(0, availH) };
  }
  // 인치/px 환산 배율 — 가로·세로 중 더 빡빡한 쪽에 맞춘다 (비율 유지)
  var scale = Math.min(availW / imgWpx, availH / imgHpx);
  var w = imgWpx * scale;
  var h = imgHpx * scale;
  var x = (slideW - w) / 2;
  var y = (slideH - h) / 2;
  return { x: x, y: y, w: w, h: h };
}

/**
 * 슬라이드 구성 계획을 데이터로 계산한다 (DOM/캡처 없이 순수 계산). 제목 슬라이드는 제외.
 *
 * 13단계에서 모델이 바뀌었다:
 *  - 레이아웃은 fit / split 두 가지뿐이다. (구 'summary' 는 "태스크 목록 표 포함"
 *    체크박스로 흡수되어 사라졌다 — 아래 includeTable 참고)
 *  - 차트 슬라이드 수(parts)는 방식별로 다른 곳에서 계산해 넣는다.
 *      image  : fit 은 항상 1장, split 은 computePngPlan 의 분할 장수
 *      shapes : planShapeSlides 의 (행 분할 × 기간 분할) 장수 — fit 이어도 2장 이상일 수 있다
 *  - 표 슬라이드는 프로젝트별이 아니라 "선택 범위 전체" 기준으로 맨 뒤에 tablePages 장 붙는다.
 *
 * @param {Array<{id?:*, name?:string, parts?:number}>} projectsWithMeta
 *        각 프로젝트 메타. parts 는 그 프로젝트의 차트 슬라이드 장수(미지정/1 이하면 1).
 * @param {string} layout 'fit'|'split' (그 외 값은 'fit' 로 취급)
 * @param {{chartMode?:'image'|'shapes', includeTable?:boolean, tablePages?:number}} [opts]
 * @returns {Array<{projectId:*, projectName:string, kind:'chart'|'table',
 *                  part:number, partCount:number}>} 앞에서부터의 슬라이드 순서 배열
 */
function planPptxSlides(projectsWithMeta, layout, opts) {
  var o = opts || {};
  var lay = (layout === 'split') ? 'split' : 'fit';
  var isShapes = (o.chartMode === 'shapes');
  var slides = [];
  (projectsWithMeta || []).forEach(function (p) {
    var id = p ? p.id : undefined;
    var name = (p && p.name != null) ? p.name : '';
    var parts = (p && p.parts > 1) ? Math.floor(p.parts) : 1;
    // 이미지 방식 + fit 은 정의상 항상 1장 (비율 유지로 축소해 한 장에 담기 때문)
    if (!isShapes && lay === 'fit') parts = 1;
    for (var i = 1; i <= parts; i++) {
      slides.push({ projectId: id, projectName: name, kind: 'chart', part: i, partCount: parts });
    }
  });
  if (o.includeTable) {
    var pages = (o.tablePages > 1) ? Math.floor(o.tablePages) : 1;
    for (var k = 1; k <= pages; k++) {
      slides.push({ projectId: null, projectName: '', kind: 'table', part: k, partCount: pages });
    }
  }
  return slides;
}

/**
 * 태스크들의 실제 기간(시작일 최소 ~ 종료일 최대)을 구한다. (ISO 'YYYY-MM-DD' 문자열 비교)
 * @param {Array<{startDate?:string, endDate?:string}>} tasks
 * @returns {{start:string, end:string}|null} 비어 있으면 null
 */
function taskDateSpan(tasks) {
  var minS = null, maxE = null;
  (tasks || []).forEach(function (t) {
    var s = t && t.startDate ? String(t.startDate) : '';
    var e = t && t.endDate ? String(t.endDate) : '';
    if (s && (minS === null || s < minS)) minS = s;
    if (e && (maxE === null || e > maxE)) maxE = e;
  });
  if (minS === null || maxE === null) return null;
  return { start: minS, end: maxE };
}

/**
 * 제목 슬라이드용 기간 라벨 'YYYY-MM-DD ~ YYYY-MM-DD' (데이터 없으면 '기간 없음').
 */
function rangeLabel(tasks) {
  var sp = taskDateSpan(tasks);
  return sp ? (sp.start + ' ~ ' + sp.end) : '기간 없음';
}

/** Date → 'YYYY-MM-DD' */
function ymdStamp(d) {
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
}

// ※ 구 buildSummaryTable(요약표 5컬럼)은 13단계에서 제거했다.
//    "태스크 목록 표 포함" 옵션이 같은 역할을 더 많은 컬럼(담당자·우선순위 추가)과
//    계층 들여쓰기로 대체하므로, 두 벌을 유지하면 사용자·코드 양쪽에서 혼란이 생긴다.
//    현재 표 생성은 pptx-shapes.js 의 buildTaskTableRows / addTaskTableSlides 한 곳뿐이다.

/**
 * 단일 캔버스에 담기 위한 배율을 정한다. 폭·높이가 모두 max 이내가 되도록 clamp 한다.
 * (fit/summary 레이아웃에서 차트가 매우 넓어 computePngPlan 이 분할을 요구해도,
 *  한 슬라이드용 이미지 1장은 반드시 만들어야 하므로 여기서 강제로 축소한다.)
 * @returns {number} 0<scale<=2
 */
function singleCanvasScale(fullWidth, fullHeight, max) {
  var m = max || PPTX_MAX_CANVAS;
  var scale = Math.min(2, m / fullWidth, m / fullHeight);
  if (!(scale > 0) || !isFinite(scale)) scale = 0.5;
  return scale;
}

// Node(테스트) 환경에서 순수 함수 검증할 수 있도록 내보내기
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SLIDE_W_IN: SLIDE_W_IN,
    SLIDE_H_IN: SLIDE_H_IN,
    PPTX_STATUS_LABELS: PPTX_STATUS_LABELS,
    PPTX_STATUS_COLORS: PPTX_STATUS_COLORS,
    statusLabelKo: statusLabelKo,
    fitImageBox: fitImageBox,
    planPptxSlides: planPptxSlides,
    taskDateSpan: taskDateSpan,
    rangeLabel: rangeLabel,
    ymdStamp: ymdStamp,
    singleCanvasScale: singleCanvasScale,
  };
}

// ─────────────────────────────────────────────────────────────
// 브라우저 UI (드롭다운 "PPTX 저장" → 캡처 → pptx 생성/저장)
// ─────────────────────────────────────────────────────────────
if (typeof document !== 'undefined') {
  (function () {
    'use strict';

    function $(id) { return document.getElementById(id); }

    // ── 토스트 (png.js/export.js 와 동일 패턴: toast-host + .toast) ──
    function showToastMsg(message, isError) {
      var host = $('toast-host');
      if (!host) {
        host = document.createElement('div');
        host.id = 'toast-host';
        host.className = 'toast-host';
        document.body.appendChild(host);
      }
      var el = document.createElement('div');
      el.className = 'toast ' + (isError ? 'toast--error' : 'toast--success');
      el.setAttribute('role', 'alert');
      el.textContent = message;
      host.appendChild(el);
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { el.classList.add('is-shown'); });
      });
      setTimeout(function () {
        el.classList.remove('is-shown');
        setTimeout(function () { el.remove(); }, 250);
      }, 3000);
    }

    // 현재 데이터 스냅샷 (gantt.js 가 노출)
    function state() {
      return (window.GanttApp && window.GanttApp.getState())
        ? window.GanttApp.getState()
        : { projects: [], tasks: [] };
    }

    function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    // ── 공통 html2canvas 옵션 (png.js 와 동일한 export-capture.js 구현을 공유) ──
    // 옵션 정의를 양쪽에 복사해 두면 한쪽만 고치는 사고가 나므로 window.ExportCapture
    // 한 곳에서만 관리한다. onclone 에서 복제 문서에 스타일시트 본문·라이트 테마·
    // CSS 변수를 주입해 캡처 결과가 스타일 없이 깨지는 문제를 막는다.
    function h2cOptions(scale, width, height) {
      return window.ExportCapture.h2cOptions(scale, width, height);
    }

    // 범례(#legend-bar)가 표시 중이면 복제해 wrapper 상단에 추가 (png.js appendLegendClone 참고)
    function appendLegendClone(wrapper, width) {
      var legendBar = $('legend-bar');
      if (!legendBar || legendBar.hidden) return;
      var legendClone = legendBar.cloneNode(true);
      legendClone.removeAttribute('id'); // 화면 요소와 id 중복 방지
      legendClone.removeAttribute('hidden');
      legendClone.style.width = width + 'px';
      wrapper.appendChild(legendClone);
    }

    /**
     * 선택 프로젝트 데이터만으로 오프스크린 차트를 그려 캡처 대상 wrapper 를 만든다.
     * (png.js buildProjectCapture 와 동일 구조 — 범례 포함, 정적 배치로 전환)
     * @returns {{wrapper, root, right, head, body, leftWidth, timelineWidth,
     *            fullWidth, fullHeight}}
     */
    function buildProjectCapture(projects, tasks) {
      var built = window.GanttApp.buildChartDom(projects, tasks);
      var root = built.root;
      var chartHeight = built.headHeight + built.bodyHeight;
      var fullWidth = built.leftWidth + built.timelineWidth;

      var wrapper = document.createElement('div');
      wrapper.style.position = 'absolute';
      wrapper.style.left = '-99999px';
      wrapper.style.top = '0';
      wrapper.style.margin = '0';
      wrapper.style.padding = '0';
      wrapper.style.background = '#ffffff';
      wrapper.classList.add('export-force-light');
      wrapper.style.width = fullWidth + 'px';

      appendLegendClone(wrapper, fullWidth);

      // buildChartDom 이 body 에 붙인 root 를 wrapper 안으로 이동 (정적 배치로 전환)
      root.style.position = 'static';
      root.style.left = '';
      root.style.top = '';
      wrapper.appendChild(root);
      document.body.appendChild(wrapper);

      var legendHeight = wrapper.offsetHeight - root.offsetHeight;
      if (legendHeight < 0) legendHeight = 0;

      return {
        wrapper: wrapper,
        root: root,
        right: root.querySelector('.gantt__right'),
        head: root.querySelector('.timeline__head'),
        body: root.querySelector('.timeline__body'),
        leftWidth: built.leftWidth,
        timelineWidth: built.timelineWidth,
        fullWidth: fullWidth,
        fullHeight: legendHeight + chartHeight,
      };
    }

    /**
     * 분할 캡처용: 복제본의 타임라인을 [sliceStartPx, +sliceWidthPx) 구간만 보이게 조정.
     * (png.js applySlice 와 동일 — 우측 폭 축소 + 헤더/본문 translateX 이동)
     * @returns {number} 이 파트의 전체 폭(px) = leftWidth + sliceWidthPx
     */
    function applySlice(cap, sliceStartPx, sliceWidthPx) {
      var partWidth = cap.leftWidth + sliceWidthPx;
      cap.wrapper.style.width = partWidth + 'px';
      cap.root.style.width = partWidth + 'px';
      cap.right.style.overflow = 'hidden';
      cap.right.style.flex = '0 0 ' + sliceWidthPx + 'px';
      cap.right.style.width = sliceWidthPx + 'px';
      var shift = 'translateX(' + (-sliceStartPx) + 'px)';
      if (cap.head) cap.head.style.transform = shift;
      if (cap.body) cap.body.style.transform = shift;
      var legendClone = cap.wrapper.firstChild;
      if (legendClone && legendClone !== cap.root && legendClone.style) {
        legendClone.style.width = partWidth + 'px';
      }
      return partWidth;
    }

    /**
     * 한 프로젝트의 차트를 레이아웃에 맞춰 PNG dataURL 이미지 배열로 캡처한다.
     * - split(그리고 실제로 분할이 필요할 때): 타임라인을 parts 구간으로 잘라 N장
     * - 그 외(fit/summary, 또는 split 이어도 한 장에 담기면): 전체 1장
     * 캡처 후 오프스크린 wrapper 는 반드시 제거(try/finally).
     * @returns {Promise<{images:Array<{dataURL,wpx,hpx}>, downscaled:boolean}>}
     */
    async function captureProjectImages(projects, tasks, layout) {
      var cap = buildProjectCapture(projects, tasks);
      try {
        var plan = computePngPlan(cap.fullWidth, cap.fullHeight, cap.leftWidth);
        var wantSplit = (layout === 'split') && plan.split;

        if (!wantSplit) {
          // ── 단일 이미지 ── (fit/summary, 또는 한 장에 담기는 split)
          // plan.split 이면(넓어서 분할 요구) 한 슬라이드용으로 강제 축소해 한 장에 담는다.
          var scale = plan.split
            ? singleCanvasScale(cap.fullWidth, cap.fullHeight, PPTX_MAX_CANVAS)
            : plan.scale;
          var canvas = await window.html2canvas(cap.wrapper,
            h2cOptions(scale, cap.fullWidth, cap.fullHeight));
          return {
            images: [{ dataURL: canvas.toDataURL('image/png'), wpx: canvas.width, hpx: canvas.height }],
            downscaled: plan.downscaled || plan.split,
          };
        }

        // ── 기간 분할(N장) ── (png.js capturePipeline 분할 경로와 동일 방식)
        var totalPx = Math.max(1, Math.round(cap.timelineWidth));
        var ranges = splitDayRanges(totalPx, plan.parts);
        var images = [];
        for (var i = 0; i < ranges.length; i++) {
          var r = ranges[i];
          var sliceStartPx = r.start;
          var sliceEndPx = (i === ranges.length - 1) ? cap.timelineWidth : r.end;
          var sliceWidthPx = sliceEndPx - sliceStartPx;
          var partWidth = applySlice(cap, sliceStartPx, sliceWidthPx);
          var partCanvas = await window.html2canvas(cap.wrapper,
            h2cOptions(plan.scale, partWidth, cap.fullHeight));
          images.push({
            dataURL: partCanvas.toDataURL('image/png'),
            wpx: partCanvas.width,
            hpx: partCanvas.height,
          });
          if (i < ranges.length - 1) await delay(50);
        }
        return { images: images, downscaled: plan.downscaled };
      } finally {
        if (cap.wrapper && cap.wrapper.parentNode) {
          cap.wrapper.parentNode.removeChild(cap.wrapper);
        }
      }
    }

    // ── 슬라이드 그리기 헬퍼 ──

    var FONT = 'Noto Sans KR';

    // 제목(1페이지) 슬라이드
    function addTitleSlide(pptx, opts) {
      var slide = pptx.addSlide();
      slide.background = { color: 'FFFFFF' };
      slide.addText(opts.title, {
        x: 0.6, y: 2.1, w: SLIDE_W_IN - 1.2, h: 1.0,
        fontFace: FONT, fontSize: 32, bold: true, align: 'center', color: '1F2937',
      });
      slide.addText('기간  ' + opts.range, {
        x: 0.6, y: 3.35, w: SLIDE_W_IN - 1.2, h: 0.5,
        fontFace: FONT, fontSize: 16, align: 'center', color: '4B5563',
      });
      slide.addText('생성일  ' + opts.created, {
        x: 0.6, y: 3.95, w: SLIDE_W_IN - 1.2, h: 0.4,
        fontFace: FONT, fontSize: 13, align: 'center', color: '6B7280',
      });
      if (opts.subtitle) {
        slide.addText(opts.subtitle, {
          x: 0.9, y: 4.6, w: SLIDE_W_IN - 1.8, h: 1.6,
          fontFace: FONT, fontSize: 12, align: 'center', color: '6B7280',
          valign: 'top',
        });
      }
      return slide;
    }

    // 차트 이미지 슬라이드
    function addChartSlide(pptx, titleText, image) {
      var slide = pptx.addSlide();
      slide.background = { color: 'FFFFFF' };
      slide.addText(titleText, {
        x: 0.3, y: 0.12, w: SLIDE_W_IN - 0.6, h: 0.4,
        fontFace: FONT, fontSize: 14, bold: true, color: '1F2937', align: 'left',
      });
      // 제목 밴드 아래 영역에 비율 유지로 배치
      var box = fitImageBox(image.wpx, image.hpx, SLIDE_W_IN, SLIDE_H_IN - TITLE_BAND_IN, IMG_MARGIN_IN);
      slide.addImage({
        data: image.dataURL,
        x: box.x, y: box.y + TITLE_BAND_IN, w: box.w, h: box.h,
      });
      return slide;
    }

    // ※ 요약표 슬라이드(addSummarySlide)는 13단계에서 제거했다.
    //    "태스크 목록 표 포함" 체크박스 → PptxShapes.addTaskTableSlides 로 일원화.

    // ─────────────────────────────────────────────────────
    // PPTX 저장 실행 (범위 + 차트 표현 방식 + 레이아웃 + 표 옵션 반영)
    // scope: {mode:'all'|'project', projectId, projectName,
    //         layout:'fit'|'split', chartMode:'image'|'shapes', includeTable:boolean}
    // ─────────────────────────────────────────────────────
    async function doPptx(scope) {
      if (typeof window.PptxGenJS !== 'function') {
        showToastMsg('PPTX 라이브러리를 불러오지 못했습니다.', true);
        return;
      }
      var chartMode = (scope && scope.chartMode === 'shapes') ? 'shapes' : 'image';
      var includeTable = !!(scope && scope.includeTable);

      // html2canvas 는 이미지 방식에서만 필요하다 (도형 방식은 캡처를 쓰지 않는다)
      if (chartMode === 'image' && typeof window.html2canvas !== 'function') {
        showToastMsg('이미지 라이브러리를 불러오지 못했습니다.', true);
        return;
      }
      // 도형 방식/표 옵션은 pptx-shapes.js 가 필요하다
      if ((chartMode === 'shapes' || includeTable) && !window.PptxShapes) {
        showToastMsg('도형 렌더링 모듈을 불러오지 못했습니다.', true);
        return;
      }

      var s = state();
      if (s.projects.length === 0) {
        showToastMsg('저장할 차트가 없습니다.', true);
        return;
      }

      var layout = (scope && scope.layout) || 'fit';
      // 대상 프로젝트 목록 결정
      var targets;
      if (scope && scope.mode === 'project') {
        targets = s.projects.filter(function (p) { return p.id === scope.projectId; });
      } else {
        targets = s.projects.slice();
      }
      if (targets.length === 0) {
        showToastMsg('선택한 프로젝트를 찾을 수 없습니다.', true);
        return;
      }

      showToastMsg('PPTX 를 생성하는 중입니다…', false);

      try {
        var pptx = new window.PptxGenJS();
        pptx.layout = 'LAYOUT_WIDE';
        pptx.author = '간트 차트';

        // ── 제목 슬라이드 ──
        var today = ymdStamp(new Date());
        var allTasks = (scope && scope.mode === 'project')
          ? filterByProject(s.projects, s.tasks, scope.projectId).tasks
          : s.tasks;
        var titleText = (scope && scope.mode === 'project')
          ? scope.projectName
          : '간트 차트 — 전체 프로젝트';
        var subtitle = '';
        if (!(scope && scope.mode === 'project')) {
          subtitle = '포함 프로젝트: ' + targets.map(function (p) { return p.name; }).join(', ');
        }
        addTitleSlide(pptx, {
          title: titleText,
          range: rangeLabel(allTasks),
          created: today,
          subtitle: subtitle,
        });

        // 도형 방식에 필요한 렌더 컨텍스트 (화면 보기 단위 · 표시 토글 · 오늘)
        var screenScale = s.scale || 'day';
        var displayFlags = s.display || {};
        var todayDate = dateStripTime(new Date());   // scope.js 전역

        // ── 프로젝트별 차트 슬라이드 ──
        for (var pi = 0; pi < targets.length; pi++) {
          var project = targets[pi];
          var f = filterByProject(s.projects, s.tasks, project.id);
          var projTasks = f.tasks;

          if (chartMode === 'shapes') {
            // 네이티브 도형으로 새로 그린다 (캡처 없음 → ppt/media 이미지 의존 없음).
            // 범위는 화면과 같은 규칙(computeRangeForTasks)으로 프로젝트 기준 재계산.
            window.PptxShapes.renderChartSlides(pptx, {
              titleBase: project.name,
              projects: f.projects,
              tasks: projTasks,
              scale: screenScale,
              today: todayDate,
              range: computeRangeForTasks(projTasks, screenScale, todayDate),
              allowDateSplit: (layout === 'split'),
              display: displayFlags,
            });
          } else {
            // 기존 방식: 오프스크린 캡처 이미지 (레이아웃별 1장 또는 N장)
            var cap = await captureProjectImages(f.projects, projTasks, layout);
            var images = cap.images;
            for (var ii = 0; ii < images.length; ii++) {
              var titleLabel = project.name +
                (images.length > 1 ? ' (' + (ii + 1) + '/' + images.length + ')' : '');
              addChartSlide(pptx, titleLabel, images[ii]);
            }
          }
        }

        // ── 태스크 목록 표 슬라이드 (옵션) — 모든 차트 슬라이드 뒤에 한 번만 ──
        if (includeTable) {
          window.PptxShapes.addTaskTableSlides(pptx, {
            titleBase: titleText,
            projects: targets,
            tasks: allTasks,
          });
        }

        // ── 파일명 · 저장 ──
        var namePart = (scope && scope.mode === 'project')
          ? sanitizeFileNamePart(scope.projectName) + '_'
          : '';
        var fileName = '간트차트_' + namePart + today + '.pptx';
        await pptx.writeFile({ fileName: fileName });
        showToastMsg('PPTX 파일을 저장했습니다.', false);
      } catch (ex) {
        showToastMsg('PPTX 저장 실패: ' + (ex && ex.message ? ex.message : ex), true);
      }
    }

    // ─────────────────────────────────────────────────────
    // 이벤트 바인딩 — "내보내기 ▾"(#excel-menu) 안의 #btn-pptx
    // ─────────────────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', function () {
      var pptxBtn = $('btn-pptx');
      if (!pptxBtn) return;
      pptxBtn.addEventListener('click', function () {
        // 드롭다운 닫기 (png.js/export.js 와 동일 처리)
        var menu = $('excel-menu');
        var excelBtn = $('btn-excel');
        if (menu) menu.hidden = true;
        if (excelBtn) excelBtn.setAttribute('aria-expanded', 'false');
        // 데이터가 없으면 모달 없이 안내 토스트
        if (state().projects.length === 0) {
          showToastMsg('저장할 차트가 없습니다.', true);
          return;
        }
        // 범위 + 차트 표현 + 레이아웃 + 표 옵션 선택 모달 → 취소면 종료
        window.ExportScope.choose({ title: 'PPTX 저장 옵션', layouts: true }).then(function (scope) {
          if (!scope) return;
          doPptx(scope);
        });
      });
    });
  })();
}
