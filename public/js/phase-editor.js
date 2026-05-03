(function () {
  'use strict';
  if (!('fetch' in window)) return;
  var section = document.querySelector('.phase-section');
  if (!section) return;

  function getRow(form) { return form.closest('.phase-row'); }
  function getFormFragmentTarget(form) {
    if (form.dataset.fragment !== 'row') return null;
    return getRow(form);
  }

  async function submitFragment(form) {
    var row = getFormFragmentTarget(form);
    if (!row) return null;
    var action = form.action;
    var fd = new FormData(form);
    var res = await fetch(action, {
      method: form.method || 'POST',
      headers: { 'Accept': 'text/html-fragment' },
      body: fd,
      credentials: 'same-origin',
    });
    var html = await res.text();
    if (res.status === 204 || /^\s*<div data-phase-deleted=/.test(html)) {
      row.remove();
      return null;
    }
    if (!res.ok) {
      var alert = document.createElement('div');
      alert.innerHTML = html;
      var node = alert.firstElementChild || alert;
      row.parentNode.insertBefore(node, row);
      return null;
    }
    var tpl = document.createElement('template');
    tpl.innerHTML = html.trim();
    var fresh = tpl.content.firstElementChild;
    if (!fresh) return null;
    row.replaceWith(fresh);
    var first = fresh.querySelector('input, button:not([disabled]), [tabindex]:not([tabindex="-1"])');
    if (first && typeof first.focus === 'function') first.focus({ preventScroll: true });
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
    if (ev.key === 'Escape') closeAllMenus();
  });

  function closeAllMenus() {
    document.querySelectorAll('.status-menu, .overflow-menu').forEach(function (m) { m.setAttribute('hidden', ''); });
    document.querySelectorAll('[aria-haspopup="menu"][aria-expanded="true"]').forEach(function (b) { b.setAttribute('aria-expanded', 'false'); });
  }
})();
