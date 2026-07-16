/* ================================================================
   Auth gate — Firebase Auth + Firestore users doc
   hr-tool model: no self-signup. Admin creates users via the admin
   panel; those users log in with a temp password and are forced to
   set a new one on first login. Admin uses simple FO/FO on first
   run (auto-bootstrapped). Everyone types "username + password" —
   internally we translate to email + SHA-256-hashed password.
   ================================================================ */

/* Firebase config — safe to commit; Firestore rules are what secure the data.
   Replace the placeholders after creating the `hl-pd-vicair` Firebase project
   (Firebase console → Project settings → General → Your apps → Web). */
const _firebaseConfig = {
  apiKey: "REPLACE_ME_FIREBASE_API_KEY",
  authDomain: "hl-pd-vicair.firebaseapp.com",
  projectId: "hl-pd-vicair",
  storageBucket: "hl-pd-vicair.firebasestorage.app",
  messagingSenderId: "REPLACE_ME_SENDER_ID",
  appId: "REPLACE_ME_APP_ID",
};

const AUTH_EMAIL_DOMAIN = "@hl-pd-vicair.local";
const AUTH_PW_SALT      = "_hl-pd-vicair_v1_salt";
const ADMIN_USERNAME    = "FO";
const ADMIN_DEFAULT_PW  = "FO";

let _fbAuth = null, _fbDb = null;

// Public API — the main app reads this
window.authGate = {
  ready: false,
  currentUser: null,     // { uid, username, name, role } — set only when signed in AND allowed
  isAdmin: false,
  signOut: () => _fbAuth && _fbAuth.signOut(),
  fbDb: () => _fbDb,
  fbAuth: () => _fbAuth,
  helpers: {
    emailFor: _emailFor,
    firebasePasswordFor: _firebasePasswordFor,
    usernameFromEmail: _usernameFromEmail,
    firebaseConfig: () => _firebaseConfig,
  },
};

function _emailFor(username) {
  return username.toLowerCase().trim() + AUTH_EMAIL_DOMAIN;
}

async function _firebasePasswordFor(userPw) {
  try {
    const buf = new TextEncoder().encode(userPw + AUTH_PW_SALT);
    const hash = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
  } catch (e) {
    return userPw.length < 6 ? (userPw + "_pad_hl-pd") : userPw;
  }
}

function _usernameFromEmail(email) {
  if (!email) return "";
  return email.replace(AUTH_EMAIL_DOMAIN, "").toUpperCase();
}

/* ---- Init ---- */

function initAuthGate() {
  if (typeof firebase === "undefined") {
    renderConfigError("Firebase SDK didn't load — check your internet connection.");
    return;
  }
  try {
    if (!firebase.apps || !firebase.apps.length) firebase.initializeApp(_firebaseConfig);
    _fbAuth = firebase.auth();
    _fbDb   = firebase.firestore();
    _fbAuth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(() => {});
  } catch (e) {
    console.error("[auth] Firebase init failed:", e);
    renderConfigError("Firebase config isn't valid yet — see the README setup instructions.");
    return;
  }

  _fbAuth.onAuthStateChanged(async (fbUser) => {
    authGate.ready = true;
    authGate.currentUser = null;
    authGate.isAdmin = false;

    if (!fbUser) { renderLoginScreen(); return; }

    try {
      let doc = await _fbDb.collection("users").doc(fbUser.uid).get();

      // Bootstrap: first-time FO login → auto-create the admin doc
      if (!doc.exists) {
        const uname = _usernameFromEmail(fbUser.email);
        if (uname === ADMIN_USERNAME) {
          await _fbDb.collection("users").doc(fbUser.uid).set({
            email: fbUser.email,
            username: ADMIN_USERNAME,
            name: "Faik Oz",
            role: "admin",
            active: true,
            mustChangePassword: false,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            createdBy: "bootstrap",
          });
          doc = await _fbDb.collection("users").doc(fbUser.uid).get();
        } else {
          // Regular user with no users/{uid} doc — shouldn't happen in this flow
          renderNoAccountScreen();
          return;
        }
      }

      const data = doc.data();
      if (!data.active) { renderRevokedScreen(data); return; }
      if (data.mustChangePassword) { renderSetPasswordScreen(fbUser, data); return; }

      // Fetch calc coefficients from Firestore before starting the app.
      // Without this, none of the calcs work — this is the "hidden formulas" lock.
      renderLoadingScreen("Loading calculator data…");
      let cfg;
      try {
        const cfgDoc = await _fbDb.collection("config").doc("coefficients").get();
        if (!cfgDoc.exists) throw new Error("Coefficient document not found in Firestore");
        cfg = cfgDoc.data();
      } catch (e) {
        console.error("[auth] coefficients fetch failed:", e);
        renderConfigError("Could not load calculator data — contact the admin. (" + (e.message || e.code) + ")");
        return;
      }
      const applied = (typeof window.setCalcCoefficients === "function") && window.setCalcCoefficients(cfg);
      if (typeof window.setTakeoffCoefficients === "function") window.setTakeoffCoefficients(cfg);
      if (!applied) {
        renderConfigError("Calculator data is malformed — contact the admin.");
        return;
      }

      authGate.currentUser = {
        uid: fbUser.uid,
        email: fbUser.email,
        username: data.username || _usernameFromEmail(fbUser.email),
        name: data.name || "",
        role: data.role || "user",
      };
      authGate.isAdmin = data.role === "admin";

      if (typeof window.startApp === "function") window.startApp();
    } catch (e) {
      console.error("[auth] user doc read failed:", e);
      renderConfigError("Could not load your account: " + (e.message || e.code));
    }
  });
}

function renderLoadingScreen(msg) {
  const root = _authRoot();
  const card = document.createElement("div");
  card.className = "auth-screen";
  card.innerHTML = `
    <div class="auth-card">
      <div class="auth-brand">⏳</div>
      <h1 class="auth-title">${escapeHTML(msg || "Loading…")}</h1>
      <div class="auth-subtitle">One moment.</div>
    </div>`;
  root.appendChild(card);
}

/* ---- Screens ---- */

function _authRoot() {
  const el = document.getElementById("app");
  el.innerHTML = "";
  return el;
}

function renderLoginScreen(err) {
  const root = _authRoot();
  const card = document.createElement("div");
  card.className = "auth-screen";
  card.innerHTML = `
    <div class="auth-card">
      <div class="auth-brand">🌡️ 💨</div>
      <h1 class="auth-title">HL + PD Calculator</h1>
      <div class="auth-subtitle">Sign in to continue</div>
      <div class="auth-form">
        <label class="auth-lbl">Username</label>
        <input class="auth-input" id="auth-u" type="text" autocomplete="username" autofocus>
        <label class="auth-lbl">Password</label>
        <input class="auth-input" id="auth-p" type="password" autocomplete="current-password">
        <div class="auth-error" id="auth-err">${err ? escapeHTML(err) : ""}</div>
        <button class="auth-btn-primary" id="auth-signin">Sign in</button>
      </div>
    </div>`;
  root.appendChild(card);
  const u = card.querySelector("#auth-u");
  const p = card.querySelector("#auth-p");
  const errEl = card.querySelector("#auth-err");
  const btn = card.querySelector("#auth-signin");
  const submit = async () => {
    errEl.textContent = "";
    const uname = u.value.trim();
    const pw = p.value;
    if (!uname || !pw) { errEl.textContent = "Enter a username and password."; return; }
    btn.disabled = true;
    btn.textContent = "Signing in…";
    try {
      const email = _emailFor(uname);
      const fbPw = await _firebasePasswordFor(pw);
      try {
        await _fbAuth.signInWithEmailAndPassword(email, fbPw);
      } catch (e) {
        // Bootstrap: first-time FO/FO → create the admin auth account
        if (uname.toUpperCase() === ADMIN_USERNAME
            && pw === ADMIN_DEFAULT_PW
            && (e.code === "auth/user-not-found"
                || e.code === "auth/invalid-credential"
                || e.code === "auth/invalid-login-credentials")) {
          const r = await _fbAuth.createUserWithEmailAndPassword(email, fbPw);
          await r.user.updateProfile({ displayName: "Faik Oz" });
          // The auth listener will now fire and create the admin user doc.
        } else {
          throw e;
        }
      }
    } catch (e) {
      console.error("[auth] sign-in failed:", e);
      errEl.textContent = _friendlyAuthError(e);
      btn.disabled = false;
      btn.textContent = "Sign in";
    }
  };
  btn.addEventListener("click", submit);
  [u, p].forEach(inp => inp.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); }));
}

function renderSetPasswordScreen(fbUser, userDoc) {
  const root = _authRoot();
  const uname = userDoc.username || _usernameFromEmail(fbUser.email);
  const card = document.createElement("div");
  card.className = "auth-screen";
  card.innerHTML = `
    <div class="auth-card">
      <div class="auth-brand">🔒</div>
      <h1 class="auth-title">Set a new password</h1>
      <div class="auth-subtitle">Welcome <b>${escapeHTML(userDoc.name || uname)}</b>. Please choose a password before you continue.</div>
      <div class="auth-form">
        <label class="auth-lbl">New password</label>
        <input class="auth-input" id="auth-p1" type="password" autocomplete="new-password" autofocus placeholder="Min 4 characters">
        <label class="auth-lbl">Confirm password</label>
        <input class="auth-input" id="auth-p2" type="password" autocomplete="new-password">
        <div class="auth-error" id="auth-err"></div>
        <button class="auth-btn-primary" id="auth-save">Save + continue</button>
        <div class="auth-form-actions">
          <button class="auth-btn-secondary" id="auth-signout-alt">Sign out</button>
        </div>
      </div>
    </div>`;
  root.appendChild(card);
  const p1 = card.querySelector("#auth-p1");
  const p2 = card.querySelector("#auth-p2");
  const err = card.querySelector("#auth-err");
  const btn = card.querySelector("#auth-save");
  const submit = async () => {
    err.textContent = "";
    if (!p1.value || p1.value.length < 4) { err.textContent = "Password must be at least 4 characters."; return; }
    if (p1.value !== p2.value) { err.textContent = "Passwords do not match."; return; }
    btn.disabled = true; btn.textContent = "Saving…";
    try {
      const newFbPw = await _firebasePasswordFor(p1.value);
      await fbUser.updatePassword(newFbPw);
      await _fbDb.collection("users").doc(fbUser.uid).update({
        mustChangePassword: false,
        passwordChangedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      // Trigger a fresh auth state check so the app can start
      window.location.reload();
    } catch (e) {
      console.error("[auth] password change failed:", e);
      err.textContent = _friendlyAuthError(e);
      btn.disabled = false; btn.textContent = "Save + continue";
    }
  };
  btn.addEventListener("click", submit);
  [p1, p2].forEach(inp => inp.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); }));
  card.querySelector("#auth-signout-alt").addEventListener("click", () => _fbAuth.signOut());
}

function renderRevokedScreen(userDoc) {
  const root = _authRoot();
  const card = document.createElement("div");
  card.className = "auth-screen";
  card.innerHTML = `
    <div class="auth-card">
      <div class="auth-brand">🚫</div>
      <h1 class="auth-title">Access revoked</h1>
      <div class="auth-subtitle">
        Your account (<b>${escapeHTML(userDoc.username || "user")}</b>) is currently disabled.<br>
        Contact <a href="mailto:faiko@vicair.com.au">faiko@vicair.com.au</a> to reactivate.
      </div>
      <div class="auth-form">
        <button class="auth-btn-secondary" id="auth-signout-alt">Sign out</button>
      </div>
    </div>`;
  root.appendChild(card);
  card.querySelector("#auth-signout-alt").addEventListener("click", () => _fbAuth.signOut());
}

function renderNoAccountScreen() {
  const root = _authRoot();
  const card = document.createElement("div");
  card.className = "auth-screen";
  card.innerHTML = `
    <div class="auth-card">
      <div class="auth-brand">⚠️</div>
      <h1 class="auth-title">No account record</h1>
      <div class="auth-subtitle">You're signed in but no account profile exists. Ask the admin to create one for you.</div>
      <div class="auth-form">
        <button class="auth-btn-secondary" id="auth-signout-alt">Sign out</button>
      </div>
    </div>`;
  root.appendChild(card);
  card.querySelector("#auth-signout-alt").addEventListener("click", () => _fbAuth.signOut());
}

function renderConfigError(msg) {
  const root = _authRoot();
  const card = document.createElement("div");
  card.className = "auth-screen";
  card.innerHTML = `
    <div class="auth-card">
      <div class="auth-brand">⚠️</div>
      <h1 class="auth-title">Setup incomplete</h1>
      <div class="auth-subtitle">${escapeHTML(msg)}</div>
    </div>`;
  root.appendChild(card);
}

function _friendlyAuthError(e) {
  const code = e && e.code ? e.code : "";
  if (code === "auth/wrong-password"
      || code === "auth/invalid-credential"
      || code === "auth/invalid-login-credentials") return "Incorrect username or password.";
  if (code === "auth/user-not-found") return "That username doesn't exist — ask an admin to create your account.";
  if (code === "auth/network-request-failed") return "Network error — check your internet connection.";
  if (code === "auth/requires-recent-login") return "Please sign out and sign in again before changing your password.";
  if (code === "auth/weak-password") return "Password is too weak.";
  return (e && e.message) || "Sign-in failed.";
}

function escapeHTML(v) {
  if (v === null || v === undefined) return "";
  return String(v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initAuthGate);
} else {
  initAuthGate();
}
