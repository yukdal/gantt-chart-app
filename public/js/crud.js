// 프로젝트/태스크 CRUD — 데이터 로딩 + 생성/수정/삭제 UI (4단계)
// - 순수 함수(페이로드 구성·검증)는 파일 상단에 두고, 브라우저가 아닌
//   Node 환경(테스트)에서도 require 할 수 있도록 파일 끝에서 module.exports 한다.
// - DOM 을 다루는 UI 코드는 파일 하단의 `typeof document !== 'undefined'` 블록에
//   모아, Node 로 require 해도 실행되지 않도록 한다.

// ─────────────────────────────────────────────────────────────
// 데이터 로딩
// ─────────────────────────────────────────────────────────────

/**
 * 서버에서 프로젝트/태스크 전체 데이터를 불러온다.
 * @returns {Promise<{projects: Array, tasks: Array}>}
 */
async function loadData() {
  const res = await fetch('/api/projects');            // 데이터 API 호출
  if (!res.ok) {
    throw new Error('데이터를 불러오지 못했습니다 (HTTP ' + res.status + ')');
  }
  const data = await res.json();                       // JSON 파싱
  // 방어적 기본값: 필드 누락 시 빈 배열
  return {
    projects: Array.isArray(data.projects) ? data.projects : [],
    tasks: Array.isArray(data.tasks) ? data.tasks : [],
  };
}

// ─────────────────────────────────────────────────────────────
// 태스크 계층 유틸 (순수 함수)
// ─────────────────────────────────────────────────────────────

/**
 * 특정 프로젝트에 속한 태스크만 걸러 반환한다.
 * @param {object[]} tasks 전체 태스크
 * @param {string} projectId 프로젝트 id
 * @returns {object[]}
 */
function getProjectTasks(tasks, projectId) {
  return tasks.filter(function (t) { return t.projectId === projectId; });
}

/**
 * 주어진 태스크의 모든 하위(자손) 태스크 id 목록을 재귀적으로 구한다.
 * (상위 태스크 선택 시 자기 자신·자손을 제외하는 데 사용)
 * @param {object[]} tasks 전체 태스크
 * @param {string} taskId 기준 태스크 id
 * @returns {string[]} 자손 id 배열 (자기 자신 제외)
 */
function getDescendantIds(tasks, taskId) {
  var result = [];
  (function collect(id) {
    tasks.forEach(function (t) {
      if ((t.parentId || null) === id) {
        result.push(t.id);
        collect(t.id);
      }
    });
  })(taskId);
  return result;
}

// ─────────────────────────────────────────────────────────────
// 클라이언트 검증 (순수 함수) — 최종 검증은 서버 응답을 따른다
// ─────────────────────────────────────────────────────────────

/**
 * 프로젝트 폼 값의 기본 검증.
 * @param {{name:string, category:string}} form
 * @returns {string|null} 문제가 있으면 한국어 메시지, 없으면 null
 */
function validateProjectForm(form) {
  if (!form.name || !form.name.trim()) return '프로젝트 이름을 입력하세요.';
  if (form.category !== 'personal' && form.category !== 'work') {
    return '분류를 선택하세요.';
  }
  return null;
}

/**
 * 태스크 폼 값의 기본 검증.
 * @param {object} form 태스크 폼 값
 * @returns {string|null} 문제가 있으면 한국어 메시지, 없으면 null
 */
function validateTaskForm(form) {
  if (!form.projectId) return '프로젝트를 선택하세요.';
  if (!form.name || !form.name.trim()) return '태스크명을 입력하세요.';
  if (!form.startDate) return '시작일을 입력하세요.';
  if (!form.endDate) return '종료일을 입력하세요.';
  // YYYY-MM-DD 문자열은 사전식 비교로 순서 판별 가능
  if (form.endDate < form.startDate) return '종료일은 시작일과 같거나 이후여야 합니다.';
  var p = Number(form.progress);
  if (form.progress === '' || form.progress == null) p = 0;
  if (!Number.isFinite(p) || p < 0 || p > 100) {
    return '진행률은 0~100 사이의 숫자여야 합니다.';
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// 서버 페이로드 구성 (순수 함수) — 서버 API 스키마와 정확히 일치해야 함
// ─────────────────────────────────────────────────────────────

/**
 * 프로젝트 생성/수정용 페이로드를 만든다.
 * @param {{name:string, category:string}} form
 * @returns {{name:string, category:string}}
 */
function buildProjectPayload(form) {
  return {
    name: (form.name || '').trim(),
    category: form.category,
  };
}

/**
 * 태스크 생성/수정용 페이로드를 만든다.
 * - 생성 시에는 projectId 포함(생성 후 변경 불가), 수정 시에는 제외한다.
 * @param {object} form 태스크 폼 값
 * @param {boolean} isEdit 수정 여부
 * @returns {object} 서버로 보낼 페이로드
 */
function buildTaskPayload(form, isEdit) {
  var payload = {
    name: (form.name || '').trim(),
    parentId: form.parentId ? form.parentId : null,
    assignee: form.assignee || '',
    startDate: form.startDate,
    endDate: form.endDate,
    progress: parseInt(form.progress, 10) || 0,
    status: form.status,
    priority: form.priority,
    milestone: !!form.milestone,
    dependencies: Array.isArray(form.dependencies) ? form.dependencies : [],
    memo: form.memo || '',
  };
  if (!isEdit) payload.projectId = form.projectId; // 생성 시에만
  return payload;
}

// Node(테스트) 환경에서 순수 함수 검증할 수 있도록 내보내기
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    getProjectTasks: getProjectTasks,
    getDescendantIds: getDescendantIds,
    validateProjectForm: validateProjectForm,
    validateTaskForm: validateTaskForm,
    buildProjectPayload: buildProjectPayload,
    buildTaskPayload: buildTaskPayload,
  };
}

// ─────────────────────────────────────────────────────────────
// CRUD UI (브라우저 전용) — Node require 시에는 실행되지 않음
// ─────────────────────────────────────────────────────────────
if (typeof document !== 'undefined') {
  (function () {
    'use strict';

    // 상태/우선순위 라벨 매핑 (값 → 화면 표시, 상태는 영문+한국어 병기)
    var STATUS_PAIRS = [
      ['plan', 'Plan (계획)'],
      ['setup', 'Set up (준비)'],
      ['ongoing', 'Ongoing (진행)'],
      ['complete', 'Complete (완료)'],
      ['delayed', 'Delayed (지연)'],
    ];
    var PRIORITY_PAIRS = [['high', '높음'], ['medium', '보통'], ['low', '낮음']];

    // 삭제 모달 확인 시 실행할 콜백 (대기 중)
    var pendingConfirm = null;

    // 활성화된 Tab 트랩 (12단계) — 패널/모달이 열려 있는 동안만 유지
    var panelTrap = null;
    var modalTrap = null;

    // ── HTML 이스케이프 (속성/텍스트 공용) ──
    function esc(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    // ── 서버 요청 헬퍼 (성공 시 JSON 반환, 실패 시 한국어 메시지로 throw) ──
    async function apiSend(method, url, body) {
      var opts = { method: method, headers: { 'Content-Type': 'application/json' } };
      if (body !== undefined) opts.body = JSON.stringify(body);
      var res = await fetch(url, opts);
      var data = null;
      try { data = await res.json(); } catch (e) { /* 본문 없음 */ }
      if (!res.ok) {
        throw new Error((data && data.error) ? data.error : ('요청 실패 (HTTP ' + res.status + ')'));
      }
      return data;
    }

    // 현재 데이터 스냅샷 (gantt.js 가 노출)
    function state() {
      return (window.GanttApp && window.GanttApp.getState())
        ? window.GanttApp.getState()
        : { projects: [], tasks: [] };
    }

    // ── DOM 참조 ──
    function $(id) { return document.getElementById(id); }

    // ─────────────────────────────────────────────────────
    // 패널 열기/닫기
    // ─────────────────────────────────────────────────────
    function openPanel(title, bodyHtml) {
      var panel = $('side-panel');
      var backdrop = $('panel-backdrop');
      $('panel-title').textContent = title;
      $('panel-body').innerHTML = bodyHtml;
      backdrop.hidden = false;
      panel.hidden = false;
      panel.setAttribute('aria-hidden', 'false');
      // 슬라이드 인: 오른쪽 바깥 → 제자리
      panel.classList.add('is-entering');
      // 다음 프레임에 클래스 제거하여 transition 발동
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { panel.classList.remove('is-entering'); });
      });

      // Tab 트랩 활성화 (12단계) — 패널 내부 첫 포커스 가능 요소로 이동
      if (window.FocusTrap) panelTrap = window.FocusTrap.activate(panel);
    }

    function closePanel() {
      var panel = $('side-panel');
      if (panel.hidden) return;
      if (panelTrap) { panelTrap.deactivate(); panelTrap = null; }
      panel.hidden = true;
      panel.setAttribute('aria-hidden', 'true');
      $('panel-backdrop').hidden = true;
      $('panel-body').innerHTML = '';
    }

    // 폼 내 에러 메시지 표시
    function showFormError(msg) {
      var box = $('form-error');
      if (!box) return;
      box.textContent = msg;
      box.hidden = false;
    }

    // ─────────────────────────────────────────────────────
    // 삭제 확인 모달
    // ─────────────────────────────────────────────────────
    function showConfirm(title, message, onConfirm) {
      $('modal-title').textContent = title;
      $('modal-msg').textContent = message;
      pendingConfirm = onConfirm;
      $('modal-backdrop').hidden = false;
      // Tab 트랩 활성화 (12단계)
      if (window.FocusTrap) modalTrap = window.FocusTrap.activate($('modal-backdrop'));
    }

    function closeConfirm() {
      if (modalTrap) { modalTrap.deactivate(); modalTrap = null; }
      $('modal-backdrop').hidden = true;
      pendingConfirm = null;
    }

    // ─────────────────────────────────────────────────────
    // 옵션 HTML 생성 헬퍼
    // ─────────────────────────────────────────────────────
    function pairOptions(pairs, selected) {
      return pairs.map(function (p) {
        var sel = p[0] === selected ? ' selected' : '';
        return '<option value="' + esc(p[0]) + '"' + sel + '>' + esc(p[1]) + '</option>';
      }).join('');
    }

    function projectOptions(projects, selectedId) {
      return projects.map(function (p) {
        var sel = p.id === selectedId ? ' selected' : '';
        return '<option value="' + esc(p.id) + '"' + sel + '>' + esc(p.name) + '</option>';
      }).join('');
    }

    // ─────────────────────────────────────────────────────
    // 프로젝트 폼
    // ─────────────────────────────────────────────────────
    function projectFormHtml(project) {
      var name = project ? project.name : '';
      var cat = project ? project.category : 'personal';
      var workNoticeText = '기관명·시험코드·대상자 정보 등 식별 가능한 내용을 입력하지 마세요. ' +
                           'Site-A, Study-1 같은 코드로 입력하세요.';
      return [
        '<form id="entity-form" class="form" novalidate>',
        '<div class="form__error" id="form-error" hidden></div>',
        '<label class="field">',
        '<span class="field__label">프로젝트 이름 <em>*</em></span>',
        '<input type="text" id="f-name" class="field__input" maxlength="100" value="' + esc(name) + '">',
        '</label>',
        '<fieldset class="field">',
        '<span class="field__label">분류</span>',
        '<div class="radio-group">',
        '<label class="radio"><input type="radio" name="category" value="personal"' + (cat === 'personal' ? ' checked' : '') + '> 개인</label>',
        '<label class="radio"><input type="radio" name="category" value="work"' + (cat === 'work' ? ' checked' : '') + '> 업무</label>',
        '</div>',
        '</fieldset>',
        '<div class="notice notice--work" id="work-notice"' + (cat === 'work' ? '' : ' hidden') + '>' + esc(workNoticeText) + '</div>',
        '<div class="form__actions">',
        '<button type="button" class="btn" id="f-cancel">취소</button>',
        '<button type="submit" class="btn btn--primary">저장</button>',
        '</div>',
        '</form>',
      ].join('');
    }

    function openProjectForm(project) {
      var isEdit = !!project;
      openPanel(isEdit ? '프로젝트 수정' : '새 프로젝트', projectFormHtml(project));

      var form = $('entity-form');
      // 업무 카테고리 선택 시 안내문 토글
      form.querySelectorAll('input[name="category"]').forEach(function (radio) {
        radio.addEventListener('change', function () {
          $('work-notice').hidden = (radio.value !== 'work') || !radio.checked;
        });
      });
      $('f-cancel').addEventListener('click', closePanel);

      form.addEventListener('submit', async function (e) {
        e.preventDefault();
        var checked = form.querySelector('input[name="category"]:checked');
        var formVals = {
          name: $('f-name').value,
          category: checked ? checked.value : '',
        };
        var err = validateProjectForm(formVals);
        if (err) { showFormError(err); return; }

        var payload = buildProjectPayload(formVals);
        try {
          if (isEdit) await apiSend('PUT', '/api/projects/' + encodeURIComponent(project.id), payload);
          else await apiSend('POST', '/api/projects', payload);
          closePanel();
          await window.GanttApp.reload();
        } catch (ex) {
          showFormError(ex.message);
        }
      });
    }

    // ─────────────────────────────────────────────────────
    // 태스크 폼
    // ─────────────────────────────────────────────────────
    function taskFormHtml(task, projects, projectId) {
      var t = task || {};
      return [
        '<form id="entity-form" class="form" novalidate>',
        '<div class="form__error" id="form-error" hidden></div>',
        '<label class="field">',
        '<span class="field__label">프로젝트 <em>*</em></span>',
        '<select id="f-project" class="field__select"' + (task ? ' disabled' : '') + '>' + projectOptions(projects, projectId) + '</select>',
        '</label>',
        '<label class="field">',
        '<span class="field__label">태스크명 <em>*</em></span>',
        '<input type="text" id="f-name" class="field__input" maxlength="200" value="' + esc(t.name || '') + '">',
        '</label>',
        '<label class="field">',
        '<span class="field__label">상위 태스크</span>',
        '<select id="f-parent" class="field__select"></select>',
        '</label>',
        '<label class="field">',
        '<span class="field__label">담당자</span>',
        '<input type="text" id="f-assignee" class="field__input" maxlength="100" value="' + esc(t.assignee || '') + '">',
        '</label>',
        '<div class="field-row">',
        '<label class="field"><span class="field__label">시작일 <em>*</em></span>',
        '<input type="date" id="f-start" class="field__input" value="' + esc(t.startDate || '') + '"></label>',
        '<label class="field"><span class="field__label">종료일 <em>*</em></span>',
        '<input type="date" id="f-end" class="field__input" value="' + esc(t.endDate || '') + '"></label>',
        '</div>',
        '<div class="field-row">',
        '<label class="field"><span class="field__label">진행률(%)</span>',
        '<input type="number" id="f-progress" class="field__input" min="0" max="100" step="1" value="' + esc(t.progress != null ? t.progress : 0) + '"></label>',
        '<label class="field"><span class="field__label">상태</span>',
        '<select id="f-status" class="field__select">' + pairOptions(STATUS_PAIRS, t.status || 'plan') + '</select></label>',
        '</div>',
        '<div class="field-row">',
        '<label class="field"><span class="field__label">우선순위</span>',
        '<select id="f-priority" class="field__select">' + pairOptions(PRIORITY_PAIRS, t.priority || 'medium') + '</select></label>',
        '<label class="field field--check"><input type="checkbox" id="f-milestone"' + (t.milestone ? ' checked' : '') + '><span class="field__label">마일스톤</span></label>',
        '</div>',
        '<label class="field">',
        '<span class="field__label">선행 태스크</span>',
        '<select id="f-deps" class="field__select" multiple></select>',
        '<span class="field__hint">Ctrl(⌘)+클릭으로 여러 개 선택 · 같은 프로젝트 태스크만</span>',
        '</label>',
        '<label class="field">',
        '<span class="field__label">메모</span>',
        '<textarea id="f-memo" class="field__textarea" maxlength="2000">' + esc(t.memo || '') + '</textarea>',
        '</label>',
        '<div class="form__actions">',
        '<button type="button" class="btn" id="f-cancel">취소</button>',
        '<button type="submit" class="btn btn--primary">저장</button>',
        '</div>',
        '</form>',
      ].join('');
    }

    // 선택된 프로젝트에 맞춰 상위 태스크·선행 태스크 셀렉트를 다시 채운다.
    function refreshRelations(projectId, task) {
      var all = state().tasks;
      var projectTasks = getProjectTasks(all, projectId);
      // 수정 중이면 자기 자신 + 모든 자손을 상위 후보에서 제외
      var excluded = {};
      if (task) {
        excluded[task.id] = true;
        getDescendantIds(all, task.id).forEach(function (id) { excluded[id] = true; });
      }

      // 상위 태스크 셀렉트 (없음 + 후보)
      var parentSel = $('f-parent');
      var curParent = task ? (task.parentId || '') : '';
      var parentHtml = '<option value="">없음</option>';
      projectTasks.forEach(function (t) {
        if (excluded[t.id]) return;
        var sel = t.id === curParent ? ' selected' : '';
        parentHtml += '<option value="' + esc(t.id) + '"' + sel + '>' + esc(t.name) + '</option>';
      });
      parentSel.innerHTML = parentHtml;

      // 선행 태스크(dependencies) 셀렉트 — 자기 자신만 제외
      var depsSel = $('f-deps');
      var curDeps = task && Array.isArray(task.dependencies) ? task.dependencies : [];
      var depsHtml = '';
      projectTasks.forEach(function (t) {
        if (task && t.id === task.id) return; // 자기 자신 제외
        var sel = curDeps.indexOf(t.id) !== -1 ? ' selected' : '';
        depsHtml += '<option value="' + esc(t.id) + '"' + sel + '>' + esc(t.name) + '</option>';
      });
      depsSel.innerHTML = depsHtml || '<option value="" disabled>선택 가능한 태스크가 없습니다</option>';
    }

    function openTaskForm(task, defaultProjectId) {
      var isEdit = !!task;
      var s = state();
      if (s.projects.length === 0) return; // 안전장치
      var projectId = isEdit ? task.projectId : (defaultProjectId || s.projects[0].id);

      openPanel(isEdit ? '태스크 수정' : '새 태스크', taskFormHtml(task, s.projects, projectId));
      refreshRelations(projectId, task || null);

      var form = $('entity-form');
      // 생성 모드에서 프로젝트를 바꾸면 상위/선행 후보를 다시 로드
      if (!isEdit) {
        $('f-project').addEventListener('change', function () {
          refreshRelations($('f-project').value, null);
        });
      }
      $('f-cancel').addEventListener('click', closePanel);

      form.addEventListener('submit', async function (e) {
        e.preventDefault();
        // 선행 태스크: 다중 선택 값 수집
        var deps = Array.prototype.slice.call($('f-deps').selectedOptions)
          .map(function (o) { return o.value; })
          .filter(function (v) { return v; });

        var formVals = {
          projectId: isEdit ? task.projectId : $('f-project').value,
          name: $('f-name').value,
          parentId: $('f-parent').value || null,
          assignee: $('f-assignee').value,
          startDate: $('f-start').value,
          endDate: $('f-end').value,
          progress: $('f-progress').value,
          status: $('f-status').value,
          priority: $('f-priority').value,
          milestone: $('f-milestone').checked,
          dependencies: deps,
          memo: $('f-memo').value,
        };

        var err = validateTaskForm(formVals);
        if (err) { showFormError(err); return; }

        var payload = buildTaskPayload(formVals, isEdit);
        try {
          if (isEdit) await apiSend('PUT', '/api/tasks/' + encodeURIComponent(task.id), payload);
          else await apiSend('POST', '/api/tasks', payload);
          closePanel();
          await window.GanttApp.reload();
        } catch (ex) {
          showFormError(ex.message);
        }
      });
    }

    // ─────────────────────────────────────────────────────
    // gantt.js(좌측 목록)에서 호출하는 공개 API
    // ─────────────────────────────────────────────────────
    window.CrudUI = {
      newProject: function () { openProjectForm(null); },
      newTask: function () { openTaskForm(null, null); },

      editProject: function (projectId) {
        var p = state().projects.find(function (x) { return x.id === projectId; });
        if (p) openProjectForm(p);
      },

      editTask: function (taskId) {
        var t = state().tasks.find(function (x) { return x.id === taskId; });
        if (t) openTaskForm(t, null);
      },

      deleteProject: function (projectId) {
        var s = state();
        var p = s.projects.find(function (x) { return x.id === projectId; });
        if (!p) return;
        var count = getProjectTasks(s.tasks, projectId).length;
        var msg = '프로젝트 "' + p.name + '" 을(를) 삭제합니다.\n' +
          (count > 0
            ? '소속 태스크 ' + count + '개도 함께 삭제됩니다. 이 작업은 되돌릴 수 없습니다.'
            : '소속된 태스크는 없습니다. 이 작업은 되돌릴 수 없습니다.');
        showConfirm('프로젝트 삭제', msg, async function () {
          await apiSend('DELETE', '/api/projects/' + encodeURIComponent(projectId));
          await window.GanttApp.reload();
        });
      },

      deleteTask: function (taskId) {
        var s = state();
        var t = s.tasks.find(function (x) { return x.id === taskId; });
        if (!t) return;
        var childCount = getDescendantIds(s.tasks, taskId).length;
        var msg = '태스크 "' + t.name + '" 을(를) 삭제합니다.\n' +
          (childCount > 0
            ? '하위 태스크 ' + childCount + '개도 함께 삭제됩니다. 이 작업은 되돌릴 수 없습니다.'
            : '이 작업은 되돌릴 수 없습니다.');
        showConfirm('태스크 삭제', msg, async function () {
          await apiSend('DELETE', '/api/tasks/' + encodeURIComponent(taskId));
          await window.GanttApp.reload();
        });
      },
    };

    // ─────────────────────────────────────────────────────
    // 전역 이벤트 바인딩
    // ─────────────────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', function () {
      // 툴바 버튼
      $('btn-add-project').addEventListener('click', function () { window.CrudUI.newProject(); });
      $('btn-add-task').addEventListener('click', function () {
        if (!$('btn-add-task').disabled) window.CrudUI.newTask();
      });

      // 패널 닫기: X 버튼 / 배경 클릭
      $('panel-close').addEventListener('click', closePanel);
      $('panel-backdrop').addEventListener('click', closePanel);

      // 모달: 취소 / 배경 클릭 / 확인
      $('modal-cancel').addEventListener('click', closeConfirm);
      $('modal-backdrop').addEventListener('click', function (e) {
        if (e.target === $('modal-backdrop')) closeConfirm();
      });
      $('modal-confirm').addEventListener('click', async function () {
        var fn = pendingConfirm;
        closeConfirm();
        if (fn) {
          try { await fn(); }
          catch (ex) { window.alert(ex.message); } // 삭제 실패는 드묾 → 간단 알림
        }
      });

      // Esc: 모달 먼저, 없으면 패널 닫기
      document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape') return;
        if (!$('modal-backdrop').hidden) { closeConfirm(); return; }
        if (!$('side-panel').hidden) closePanel();
      });
    });
  })();
}
