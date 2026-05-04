// Sticky chrome height sync. The .subtabs bar uses
//   position: sticky; top: var(--page-header-height);
// so it parks immediately below the sticky page-header. The static
// 96px default in app.src.css is the minimum case; admin customer
// pages with eyebrow + title + subtitle + actions can be 140-160px,
// causing the subtabs bar to overlap and cut off the bottom of the
// page-header.
//
// Measure the real height on load + on resize + when the header's
// content changes, and write it into the CSS variable.
(function () {
  'use strict';
  var header = document.querySelector('.page-header');
  if (!header) return;

  function sync() {
    var h = header.offsetHeight;
    document.documentElement.style.setProperty('--page-header-height', h + 'px');
  }

  sync();
  if (typeof ResizeObserver === 'function') {
    var ro = new ResizeObserver(sync);
    ro.observe(header);
  } else {
    window.addEventListener('resize', sync);
  }
})();
