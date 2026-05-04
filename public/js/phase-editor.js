(function () {
  'use strict';
  if (!('fetch' in window)) return;
  var section = document.querySelector('.phase-section');
  if (!section) return;

  // Single sr-only live region announces save / error / delete outcomes
  // so screen-reader users get feedback even though the DOM swap is silent.
  var LIVE = document.createElement('div');
  LIVE.setAttribute('aria-live', 'polite');
  LIVE.setAttribute('aria-atomic', 'true');
  LIVE.className = 'visually-hidden';
  document.body.appendChild(LIVE);
  function announce(msg) { LIVE.textContent = ''; setTimeout(function () { LIVE.textContent = msg; }, 50); }

  function getRow(form) { return form.closest('.phase-row'); }
  function getFormFragmentTarget(form) {
    if (form.dataset.fragment !== 'row') return null;
    return getRow(form);
  }

  function clearRowAlert(row) {
    var prev = row.previousElementSibling;
    if (prev && prev.classList.contains('phase-row__alert')) prev.remove();
  }

  async function submitFragment(form) {
    var row = getFormFragmentTarget(form);
    if (!row) return null;
    if (form.dataset.submitting === '1') return null;
    form.dataset.submitting = '1';
    clearRowAlert(row);
    row.setAttribute('aria-busy', 'true');
    row.classList.add('phase-row--loading');
    // Send urlencoded, NOT multipart. @fastify/csrf-protection reads _csrf
    // from req.body, and the route layer only registers @fastify/formbody
    // (which handles application/x-www-form-urlencoded). FormData would
    // post as multipart/form-data — that body never lands on req.body, so
    // the CSRF lookup misses and the route rejects with FST_CSRF_INVALID_TOKEN.
    var fd = new FormData(form);
    var params = new URLSearchParams();
    fd.forEach(function (value, key) { params.append(key, value); });
    var res, html;
    try {
      res = await fetch(form.action, {
        method: form.method || 'POST',
        headers: {
          'Accept': 'text/html-fragment',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
        credentials: 'same-origin',
      });
      html = await res.text();
    } finally {
      row.removeAttribute('aria-busy');
      row.classList.remove('phase-row--loading');
      delete form.dataset.submitting;
    }
    if (res.status === 204 || /^\s*<div data-phase-deleted=/.test(html)) {
      row.remove();
      announce('Phase removed.');
      return null;
    }
    if (!res.ok) {
      var wrap = document.createElement('div');
      wrap.innerHTML = html;
      var alertNode = wrap.firstElementChild || wrap;
      alertNode.classList.add('phase-row__alert');
      row.parentNode.insertBefore(alertNode, row);
      announce('Error: changes could not be saved.');
      return null;
    }
    var tpl = document.createElement('template');
    tpl.innerHTML = html.trim();
    var fresh = tpl.content.firstElementChild;
    if (!fresh) return null;
    row.replaceWith(fresh);
    var first = fresh.querySelector('input, button:not([disabled]), [tabindex]:not([tabindex="-1"])');
    if (first && typeof first.focus === 'function') {
      first.focus();
      if (typeof first.scrollIntoView === 'function') first.scrollIntoView({ block: 'nearest' });
    }
    announce('Changes saved.');
    return fresh;
  }

  section.addEventListener('submit', function (ev) {
    var form = ev.target.closest('form[data-fragment="row"]');
    if (!form) return;
    ev.preventDefault();
    submitFragment(form).catch(function () {
      form.removeAttribute('data-fragment');
      form.submit();
    });
  });

  // Autosave-on-blur for label inputs and inline date inputs.
  section.addEventListener('blur', function (ev) {
    var input = ev.target.closest('input.phase-row__label-input, input.phase-row__date');
    if (!input) return;
    var original = input.dataset.originalValue;
    if (input.value === original) return;
    var form = input.closest('form');
    if (!form) return;
    submitFragment(form);
  }, true);

  // Status menu + overflow menu open/close (delegated, document-level so
  // popovers can be dismissed by clicks outside the phase section).
  document.addEventListener('click', function (ev) {
    var statusBtn = ev.target.closest('[data-status-menu] > .status-pill--button');
    if (statusBtn) {
      ev.preventDefault();
      var wrap = statusBtn.parentElement;
      var menu = wrap.querySelector('.status-menu');
      var open = !menu.hasAttribute('hidden');
      closeAllMenus();
      if (!open) {
        menu.removeAttribute('hidden');
        statusBtn.setAttribute('aria-expanded', 'true');
      }
      return;
    }
    var statusItem = ev.target.closest('.status-menu__item');
    if (statusItem) {
      ev.preventDefault();
      var sWrap = statusItem.closest('[data-status-menu]');
      var form = sWrap.querySelector('.phase-row__status-form');
      var input = form.querySelector('[data-status-input]');
      input.value = statusItem.dataset.setStatus;
      closeAllMenus();
      submitFragment(form);
      return;
    }
    var overflowBtn = ev.target.closest('[data-overflow-menu] > .btn');
    if (overflowBtn) {
      ev.preventDefault();
      var oWrap = overflowBtn.parentElement;
      var oMenu = oWrap.querySelector('.overflow-menu');
      var oOpen = !oMenu.hasAttribute('hidden');
      closeAllMenus();
      if (!oOpen) {
        oMenu.removeAttribute('hidden');
        overflowBtn.setAttribute('aria-expanded', 'true');
      }
      return;
    }
    if (!ev.target.closest('.status-menu, .overflow-menu')) closeAllMenus();
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape') return;
    var openTrigger = document.querySelector('[aria-haspopup="menu"][aria-expanded="true"]');
    closeAllMenus();
    if (openTrigger && typeof openTrigger.focus === 'function') openTrigger.focus();
  });

  function closeAllMenus() {
    document.querySelectorAll('.status-menu, .overflow-menu').forEach(function (m) { m.setAttribute('hidden', ''); });
    document.querySelectorAll('[aria-haspopup="menu"][aria-expanded="true"]').forEach(function (b) { b.setAttribute('aria-expanded', 'false'); });
  }

  // Drag-to-reorder phases via the HTML5 Drag and Drop API. The 6-dot
  // handle (.phase-row__handle) signals draggability via CSS; the row
  // root carries draggable=true so the whole card is the drag target.
  // On drop, compute the new index and POST to the /set-order route.
  var draggingId = null;
  var draggingEl = null;

  section.addEventListener('dragstart', function (ev) {
    var row = ev.target.closest('li.phase-row[data-phase-id]');
    if (!row) return;
    draggingEl = row;
    draggingId = row.getAttribute('data-phase-id');
    if (ev.dataTransfer) {
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', draggingId);
    }
    setTimeout(function () { row.classList.add('phase-row--dragging'); }, 0);
  });

  function clearDropMarkers() {
    section.querySelectorAll('.phase-row--drop-before, .phase-row--drop-after').forEach(function (r) {
      r.classList.remove('phase-row--drop-before', 'phase-row--drop-after');
    });
  }

  section.addEventListener('dragend', function () {
    if (draggingEl) draggingEl.classList.remove('phase-row--dragging');
    clearDropMarkers();
    draggingEl = null; draggingId = null;
  });

  section.addEventListener('dragover', function (ev) {
    var target = ev.target.closest('li.phase-row[data-phase-id]');
    if (!target || target === draggingEl) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
    var rect = target.getBoundingClientRect();
    var before = (ev.clientY - rect.top) < rect.height / 2;
    clearDropMarkers();
    target.classList.add(before ? 'phase-row--drop-before' : 'phase-row--drop-after');
  });

  section.addEventListener('drop', function (ev) {
    var target = ev.target.closest('li.phase-row[data-phase-id]');
    if (!target || !draggingId || target === draggingEl) return;
    ev.preventDefault();
    var rect = target.getBoundingClientRect();
    var before = (ev.clientY - rect.top) < rect.height / 2;
    var allRows = Array.prototype.slice.call(section.querySelectorAll('li.phase-row[data-phase-id]'));
    var withoutDragged = allRows.filter(function (r) { return r !== draggingEl; });
    var targetIdx = withoutDragged.indexOf(target);
    var insertAt = before ? targetIdx : targetIdx + 1;

    var anyForm = section.querySelector('form input[name="_csrf"]');
    var csrf = anyForm ? anyForm.value : '';
    var url = '/admin/customers/' + window.__phaseSectionCustomerId
            + '/projects/' + window.__phaseSectionProjectId
            + '/phases/' + draggingId + '/set-order';

    var params = new URLSearchParams();
    params.append('_csrf', csrf);
    params.append('target_index', String(insertAt));

    fetch(url, {
      method: 'POST',
      headers: {
        'Accept': 'text/html',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
      credentials: 'same-origin',
    }).then(function (res) {
      if (res.redirected || res.ok) {
        window.location.reload();
      } else {
        announce('Could not reorder — please retry.');
      }
    }).catch(function () {
      announce('Could not reorder — please retry.');
    });
  });
})();
