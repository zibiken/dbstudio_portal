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
    var fd = new FormData(form);
    var res, html;
    try {
      res = await fetch(form.action, {
        method: form.method || 'POST',
        headers: { 'Accept': 'text/html-fragment' },
        body: fd,
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

  // Autosave-on-blur for label inputs.
  section.addEventListener('blur', function (ev) {
    var input = ev.target.closest('input.phase-row__label-input');
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
})();
