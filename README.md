# v15 — Security Fix: Admin Role Self-Escalation (2026-07-31)

## What I found, checking your "is it secure" question

Good news first: nothing sensitive is actually exposed in the public repo.
Your Razorpay Key Secret, webhook secret, and Gmail App Password are only
ever referenced via `defineSecret(...)` and pulled from Firebase Secret
Manager at runtime — none of them are typed into any file that gets
committed. The Firebase `apiKey` and Razorpay `rzp_live_...` Key ID that
*are* visible in your HTML/JS are supposed to be public — that's how
Firebase and Razorpay design client-side identifiers; the real protection
is your Firestore rules and Razorpay's server-side signature checks, both
already in place.

**But I did find one real, exploitable bug while checking this**, not
hypothetical — worth fixing regardless of whether the repo is public or
private:

### The bug: anyone could make themselves an admin

`register.html` decides whether a new signup should get `role: "admin"" or
`role: "member"` by checking the email against a hardcoded list
(`ADMIN_EMAILS`, currently just your two accounts) — but that check only
lives in the browser. The actual Firestore rule that was supposed to be
the real gate, `allow create` on `/users/{userId}`, only checked that the
uid matched the signed-in account. It never restricted what value `role`
could be set to on that very first write.

That means anyone could sign up for an account and, instead of letting
`register.html`'s normal code run, just call Firestore's `setDoc` directly
(trivial from the browser console, no special tools needed) with
`role: "admin"` in the payload — and the rules would have allowed it. From
there they'd have full admin access: the Admin Dashboard, the ability to
approve founder stage advancements, mark Marketplace payouts as paid, read
every order and profile on the site.

Your `update` rule already correctly blocked *changing* role after the
fact (`request.resource.data.role == resource.data.role`) — the gap was
specifically on the very first `create`.

### The fix
`firestore.rules` now checks the *verified* email on the person's Firebase
Auth token (which a client cannot forge — it's only set by Firebase itself
after real authentication), and only allows `role: "admin"` to be set on
creation for `pramod@ried.co.in` / `neel@ried.co.in`. Everyone else is
forced to `role: "member"`, full stop. This mirrors the exact same
`ADMIN_EMAILS` list `register.html` already uses, just enforced somewhere
an attacker can't bypass it.

Nothing else changed — no other file, no other rule.

## Deploy checklist
This is a rules-only change, so it's a quick one:

1. Copy `firestore.rules` from this folder over the one in your repo, and
   push to GitHub.
2. From Cloud Shell:
   ```
   cd ~
   rm -rf ~/ried
   git clone https://github.com/neelkamal213/ried.git ~/ried
   cd ~/ried
   firebase deploy --only firestore:rules,firestore:indexes
   ```
   You should see `✔ Deploy complete!` — no Functions redeploy needed this
   time, this is purely a Firestore rules change.
3. Nothing to test as a "before/after" on the site itself — this closes a
   backend-only hole, there's no UI change. If you want to confirm it's
   live: Firebase Console → Firestore Database → Rules tab, and you should
   see the new admin-email check inside the `/users` match block.

## Other things worth knowing (not urgent, no action needed unless you want to)
A few lower-effort, optional hardening ideas from the same security review,
none of which are fixes for an actual bug like the one above — just good
housekeeping for a public repo:

- **GitHub secret scanning + push protection** (Settings → Code security)
  — free on public repos, scans your whole git history for anything that
  looks like a leaked key, and blocks future commits containing one before
  they land. Worth turning on once just for peace of mind.
- **Dependabot alerts** on `functions/package.json` — notifies you if a
  dependency you rely on gets a security patch. Your last deploy's `npm
  install` reported "10 vulnerabilities (9 moderate, 1 high)" — almost
  certainly in transitive build-tooling dependencies rather than anything
  that runs in production, but worth a `npm audit` read-through sometime
  to confirm.
- **Branch protection on `main`** (require a pull request before merging)
  — mostly guards against an accidental bad push rather than an attack,
  since right now anyone with write access to the repo can push straight
  to what's live.
- Firebase **App Check** is still not set up on this project (noted back
  in Tier 8 too) — it would stop bots/scripts from calling your Cloud
  Functions directly outside of your real website, which matters more now
  that you have several public-facing functions (checkout, quote requests,
  the Razorpay webhook). Bigger lift than the others, only worth it if you
  start seeing unexplained function invocations/costs.
