# v13 — Sitewide Button/Form/Modal Animation Polish (2026-07-30)

This is the first pass on the "international look and feel" ask — specifically
targeting what you called out: hover/click animations on buttons, form
inputs, and modals feeling clunky. Only one file changed: `style.css`. No
HTML changed, no Cloud Functions redeploy needed, no Console/Cloud Shell
steps at all this time — just copy the file over and push.

## Why only one file
Nearly every button, form input, and modal on the site already reuses the
same handful of shared CSS classes (`.btn-primary`/`.btn-secondary`,
`.onboard-input`, `.contact-form input`, `.marketplace-overlay`/
`.marketplace-modal`, etc.) across every page. Upgrading those shared
classes once in `style.css` cascades the improvement to every page that
uses them automatically — Marketplace, Packages, login/register/contact,
My Listings, the founder dashboard, everywhere — without touching or
risking breakage in 20 separate HTML files.

## What actually changed

**Buttons** (every `.btn-primary`/`.btn-secondary` sitewide, plus
`.service-btn` on the Services page and the `.package-btn` cards on
Packages):
- A real **press-down (`:active`) state** — buttons now visibly respond the
  instant you click, before the hover-lift animation even finishes. This was
  the single biggest thing missing that made buttons feel "dead" or clunky
  on click — previously there was only a hover effect, nothing distinct for
  an actual click.
- Smoother, slightly snappier transition timing (a bouncier easing curve for
  the lift/press, a separate faster curve for shadows/color) instead of one
  generic `all 0.3s` transition, which tends to feel sluggish when several
  properties change at once.

**Form inputs** (every login/register/contact field, plus every onboarding/
listing/checkout field — `.onboard-input` and `.contact-form input`):
- Login, Register, and the Contact form's inputs had **no focus styling or
  transition at all** before this — clicking into a field just… did nothing
  visually. They now get the same smooth focus glow (a soft blue ring) and
  border transition that the onboarding/checkout forms already had, so
  every form field sitewide now behaves the same way.
- A subtle hover-border change on all inputs, so a field gives a little
  feedback even before you click into it.

**Modals** (the cart panel, listing-detail popup, and Packages'
checkout/quote modals — all share `.marketplace-overlay`/
`.marketplace-modal`):
- These previously just snapped instantly into view with no animation at
  all. They now fade in and gently settle into place (a quick
  fade + slight upward pop), which is most of what "the boxes... are not
  correct" was almost certainly describing.
- The small round close (×) button and the cart's quantity +/- and remove
  buttons also got proper hover/press feedback — previously these had zero
  transition, so they felt static compared to the rest of the site.

## What this does NOT include (next steps, if you want to keep going)
- **Exit animations** — closing a modal is still instant (no fade-out) since
  that would need a small JavaScript change (delay actually hiding the
  element until a fade-out animation finishes) rather than a CSS-only fix.
  Straightforward to add in a follow-up round if you want it.
- **Layout/spacing changes** — this round is purely about motion/feedback
  quality, not resizing or rearranging anything. If specific boxes still
  look cramped or oddly spaced once you look at this live, point them out
  and I'll fix those individually.
- **A broader visual refresh** (typography, color intensity, imagery style)
  — this was scoped specifically to animations per your feedback on the
  screenshot. If "international look and feel" means more than smoother
  motion once you see this live, let me know what specifically still feels
  off and I'll keep iterating.

## Deploy checklist
1. Copy `style.css` from this folder over the one in your repo (replaces
   the whole file — it's the same file, just with the additions above).
2. Push to GitHub. That's it — no Cloud Shell, no Console, nothing else
   needed for this round.
3. Test live: hover and click a few buttons (nav, package cards, the
   "Continue to Payment" button in the checkout modal), focus into a login/
   contact form field, and open/close the Marketplace cart or a Packages
   checkout modal — everything should now feel smoother and give visible
   feedback on click.
