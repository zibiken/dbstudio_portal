(function () {
  'use strict';

  function isDialogSupported() {
    return typeof HTMLDialogElement === 'function';
  }

  function findDialog(details) {
    return details.querySelector('.confirm-dialog__dialog');
  }

  function openFromSummary(details, summary, ev) {
    var dlg = findDialog(details);
    if (!dlg || !isDialogSupported()) return;
    ev.preventDefault();
    details.open = false;
    dlg.__cdTrigger = summary;
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
    var first = dlg.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (first) first.focus();
  }

  function close(dlg) {
    if (typeof dlg.close === 'function') dlg.close();
    else dlg.removeAttribute('open');
    var trigger = dlg.__cdTrigger;
    if (trigger && typeof trigger.focus === 'function') trigger.focus();
  }

  document.addEventListener('click', function (ev) {
    var summary = ev.target.closest('details[data-confirm-dialog] > summary');
    if (summary) {
      var details = summary.parentElement;
      openFromSummary(details, summary, ev);
      return;
    }
    var cancel = ev.target.closest('[data-confirm-dialog-cancel]');
    if (cancel) {
      ev.preventDefault();
      var dlg = cancel.closest('dialog');
      if (dlg) close(dlg);
    }
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape') return;
    var dlg = document.querySelector('dialog.confirm-dialog__dialog[open]');
    if (dlg) {
      ev.preventDefault();
      close(dlg);
    }
  });
})();
