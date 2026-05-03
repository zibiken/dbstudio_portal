(function () {
  'use strict';
  var sentinel = document.querySelector('.chrome-sentinel');
  if (!sentinel || typeof IntersectionObserver !== 'function') return;
  var io = new IntersectionObserver(function (entries) {
    var entry = entries[0];
    if (!entry) return;
    document.body.setAttribute('data-stuck', entry.isIntersecting ? 'false' : 'true');
  }, { threshold: 0 });
  io.observe(sentinel);
})();
