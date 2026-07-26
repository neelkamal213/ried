// Shared, site-wide auth-aware nav + session-timeout behaviour.
// Import this on every page (public marketing pages AND signed-in-only
// pages like dashboard.html/account.html/my-listings.html/admin-dashboard.html):
//
//   <script type="module" src="js/auth-nav.js"></script>
//
// What it does:
//   1. Finds the nav link with id="navAuthLink" (the "Sign In" link in the
//      header) and flips it to "Dashboard" -> dashboard.html (or
//      admin-dashboard.html for the two admin emails) whenever a user is
//      signed in, and flips it back to "Sign In" -> login.html the moment
//      they sign out / aren't logged in. Pages that don't have a
//      navAuthLink element (e.g. profile-setup.html) just skip this part
//      silently — it's a no-op if the element isn't found.
//   2. Starts a 30-minute inactivity timer the moment a user is detected as
//      signed in. Any mouse move, click, keypress, scroll or touch resets
//      the timer. If 30 minutes pass with zero activity, the user is
//      signed out and sent to login.html?timeout=1 (login.html shows a
//      "you were signed out due to inactivity" notice for that flag).
//      Nothing happens for signed-out visitors — the timer only ever runs
//      while auth.currentUser is set.
import { auth, ADMIN_EMAILS, onAuthStateChanged, signOut } from "./firebase-init.js";

const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

let idleTimer = null;
let watching = false;

function handleTimeout() {
  signOut(auth).catch(() => {}).finally(() => {
    window.location.href = 'login.html?timeout=1';
  });
}

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(handleTimeout, SESSION_TIMEOUT_MS);
}

const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'click'];

function startIdleWatch() {
  if (watching) { resetIdleTimer(); return; }
  watching = true;
  ACTIVITY_EVENTS.forEach(evt => window.addEventListener(evt, resetIdleTimer, { passive: true }));
  resetIdleTimer();
}

function stopIdleWatch() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (watching) {
    ACTIVITY_EVENTS.forEach(evt => window.removeEventListener(evt, resetIdleTimer));
    watching = false;
  }
}

onAuthStateChanged(auth, (user) => {
  const link = document.getElementById('navAuthLink');

  if (user) {
    if (link) {
      const isAdmin = ADMIN_EMAILS.includes((user.email || '').toLowerCase());
      link.textContent = 'Dashboard';
      link.setAttribute('href', isAdmin ? 'admin-dashboard.html' : 'dashboard.html');
    }
    startIdleWatch();
  } else {
    if (link) {
      link.textContent = 'Sign In';
      link.setAttribute('href', 'login.html');
    }
    stopIdleWatch();
  }
});
