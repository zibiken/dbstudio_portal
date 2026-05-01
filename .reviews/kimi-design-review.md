# Kimi Design Review
**Timestamp:** 2026-05-01T22:08:23Z
**Repository:** /opt/dbstudio_portal
**Model:** kimi-k2.6

## Summary
This changeset introduces new CSS primitives for bare form elements (`.form-label`, `.form-textarea`), a customer waiting-page panel, and a dashboard “Questions for you” card/list pattern. It also updates the customer question detail page to use a standard `.form-actions` wrapper and bumps the tertiary skip button from `sm` to `md`.

## Blocking UI/UX Issues
None identified.

## Recommended Improvements
1. **Keyboard parity for hover cards** — `.customer-questions__item--open` gains a green border + shadow on `:hover` but not on `:focus-within`. Keyboard users tabbing through the list won’t get the same elevated affordance.
2. **Link arrow decoration** — The trailing arrow on `.customer-questions__link` is injected via `content: ' →'`. CSS-generated characters are sometimes announced by screen readers (e.g., “right arrow”). Moving the arrow into a `<span aria-hidden="true">→</span>` inside the link would eliminate that noise.
3. **Visual hierarchy check** — The skip button was bumped from `sm` to `md`. Verify that the primary “Submit answer” button in the same view is at least as prominent (ideally larger or same size with stronger fill contrast) so the tertiary action doesn’t visually compete.
4. **Definition-list resilience** — The waiting-page `dl` uses `grid-template-columns: max-content 1fr`. A long `dt` label can force the second column to become too narrow on small screens. Add a narrow-viewport fallback and `overflow-wrap` on `dd`.

## Accessibility Concerns
1. **Focus indicator consistency** — The new `.form-textarea` follows the existing pattern of `outline: none` on `:focus` + `outline` on `:focus-visible`. This is acceptable for modern browsers, but ensure the `border-color` shift to `--c-moss` is visible in Windows High Contrast / forced-colors mode (where `box-shadow` and `border-color` changes may be suppressed). A transparent `outline` fallback or media query for `forced-colors: active` would make this bulletproof.
2. **Color-only links** — The global link style removes underlines by default (relying on color). The waiting-page support link inherits this. While context helps, underlined links are safer for colorblind users.

## Mobile / Responsive Concerns
1. **Waiting-page grid overflow** — As noted above, `max-content` can push content off-screen on mobile if labels are long. A single-column stack below `480px` prevents horizontal overflow.
2. **Touch targets** — The dashboard question links use `display: block` with `padding: var(--s-3) var(--s-4)`. Assuming your spacing scale uses `≥12px`, the hit area should meet the 44×44dp guideline.

## Copy / Content Suggestions
- “Skip / I don’t know” is honest and clear. No changes needed.

## Suggested Implementation Notes
- Add `:focus-within` alongside `:hover` on `.customer-questions__item--open`.
- Add `overflow-wrap: break-word` to `.customer-waiting__panel dd`.
- Verify `.form-actions` has appropriate `margin-top` / `gap` rules elsewhere in the stylesheet so the skip form sits clearly separated from the primary answer form.

## Optional Patch
```diff
--- a/public/styles/app.src.css
+++ b/public/styles/app.src.css
@@ -1047,6 +1047,10 @@ body:not(.public) .eyebrow { color: var(--fg-on-light-muted); }
   border-color: var(--c-moss);
   box-shadow: 0 2px 8px rgba(47, 93, 80, 0.12);
 }
+.customer-questions__item--open:focus-within {
+  border-color: var(--c-moss);
+  box-shadow: 0 2px 8px rgba(47, 93, 80, 0.12);
+}
 .customer-questions__link {
   display: block;
   padding: var(--s-3) var(--s-4);
@@ -1061,6 +1065,19 @@ body:not(.public) .eyebrow { color: var(--fg-on-light-muted); }
   font-weight: 600;
 }
 
+/* Mobile: stack definition-list rows when labels are long */
+@media (
