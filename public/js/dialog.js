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

  // showModal() puts the dialog in the top layer but doesn't trap Tab
  // focus by default — Tab can escape to the rest of the document. Wrap
  // focus between the first and last focusable elements inside the open
  // dialog so screen-reader and keyboard users stay in context.
  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Tab') return;
    var dlg = document.querySelector('dialog.confirm-dialog__dialog[open]');
    if (!dlg) return;
    var focusable = dlg.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (focusable.length === 0) return;
    var first = focusable[0];
    var last = focusable[focusable.length - 1];
    if (ev.shiftKey && document.activeElement === first) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && document.activeElement === last) {
      ev.preventDefault();
      first.focus();
    }
  });
})();
