// Sticky chrome is now pure CSS (position: sticky on .page-header +
// .subtabs). Earlier IntersectionObserver-driven size changes caused
// a feedback loop visible as flicker — see public/styles/app.src.css
// "sticky chrome" block. This file is intentionally a no-op so the
// existing <script> tag in views/layouts/{admin,customer}.ejs keeps
// loading without a 404. Remove this file + the layout <script> on
// the next pass that touches both files.
(function () { 'use strict'; })();
