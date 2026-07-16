# Firebase setup — HL + PD Calculator

Follow these steps once, then again only if you rotate the project.

**Prerequisites:** a Google account, Node 18+ (for the Firebase CLI).

---

## 1. Create the Firebase project

1. Go to [https://console.firebase.google.com](https://console.firebase.google.com)
2. **Add project** → name it `hl-pd-vicair` (must match `.firebaserc`)
3. Disable Google Analytics (not needed) → **Create project**
4. Stay on the **Spark (free)** plan

## 2. Register a Web app

1. In the project overview, click the **`</>`** (Web) icon
2. Nickname: `hl-pd-web`
3. **Don't** enable Firebase Hosting from this dialog (we'll do it via CLI)
4. **Register app**
5. Copy the `firebaseConfig` object it shows you
6. Open `auth.js` and replace the placeholder config block at the top:
   ```js
   const _firebaseConfig = {
     apiKey: "REPLACE_ME...",       // ← paste your apiKey
     authDomain: "hl-pd-vicair.firebaseapp.com",
     projectId: "hl-pd-vicair",
     storageBucket: "hl-pd-vicair.firebasestorage.app",
     messagingSenderId: "REPLACE_ME...",
     appId: "REPLACE_ME...",
   };
   ```

> **Safe to commit:** the config is public — Firestore rules do the real securing.

## 3. Enable Email/Password auth

1. Firebase console → **Build → Authentication → Get started**
2. **Sign-in method** tab → **Email/Password** → toggle **Enable** → **Save**
3. (Leave every other provider disabled.)

## 4. Enable Firestore

1. Firebase console → **Build → Firestore Database → Create database**
2. **Start in production mode** (rules will be pushed from this repo)
3. Location: `australia-southeast2` (Melbourne) — matches your `hr-tool-vicair`
4. **Enable**

## 5. Install Firebase CLI + log in

```bash
npm install -g firebase-tools
firebase login
```

## 6. Push the Firestore rules

From the project folder:

```bash
firebase deploy --only firestore:rules
```

This reads `firestore.rules` and `.firebaserc` in the folder and pushes the rules to your project.

## 7. Seed the calc coefficients

The tool won't work until `config/coefficients` exists in Firestore.

1. Open `seed/coefficients.json` (gitignored, stays local) — you should already have it.
2. In the Firebase console → **Firestore Database**
3. **Start collection** → collection ID `config` → next
4. Document ID: `coefficients`
5. Add fields — the easiest way: click the **⋮** on the doc → **Import JSON**. If that option is missing in your console version, add each top-level field manually with the correct type (map for the nested objects, number for the scalars).
6. Verify: `config/coefficients` should have every top-level key from `seed/coefficients.json`.

> If any coefficient is missing at load time, the tool boots with 0/empty and every calc returns 0.

## 8. Enable Firebase Hosting

```bash
firebase deploy --only hosting
```

First run will ask you to confirm. It publishes the current folder as the site (public settings in `firebase.json`).

Your app is now live at: `https://hl-pd-vicair.web.app` (also `.firebaseapp.com`).

## 9. First-time admin login

1. Open the deployed site
2. Sign in with username **`FO`** and password **`FO`**
3. The tool bootstraps: creates a Firebase Auth user for FO, and writes `users/{uid}` with `role: admin, active: true`
4. You'll land on the app. The **⚙ Admin** button appears in the top nav.

**Change FO's password immediately** — in the app:
- Sign out
- Sign back in as `FO / FO`
- (Optional) Delete FO's account from the admin panel and re-create it, OR reset the password from the Firebase console (Authentication → Users → find `fo@hl-pd-vicair.local` → ⋯ → Reset password). But note: the app hashes passwords with SHA-256, so resetting via console breaks the app's expectations. **Simplest secure approach: never share FO/FO credentials, treat them as a bootstrap only, and rotate the FO password via Firebase console once and remember the new hash mapping**. Or: delete the FO auth record entirely and re-bootstrap with a different reserved admin username by editing `ADMIN_USERNAME` in `auth.js`.

## 10. Add regular users

1. In the app (as FO), click **⚙ Admin**
2. **+ Add user** → username + name + role → **Create user**
3. Copy the temp password from the modal → send to the user via email/Slack
4. The user signs in with username + temp password → forced to set a new password → app appears

## Rolling changes

- **Update rules**: edit `firestore.rules`, then `firebase deploy --only firestore:rules`
- **Update coefficients**: edit `seed/coefficients.json` locally + edit the `config/coefficients` doc in Firebase console. (Or use Firestore Import.)
- **Deploy code changes**: `firebase deploy --only hosting`

## What lives where

| Where | What | Public? |
|---|---|---|
| GitHub repo (public) | HTML/CSS/JS, `firebase.json`, `firestore.rules`, `LICENSE.md`, `README.md`, `docs/` | Yes |
| GitHub repo (gitignored) | `seed/coefficients.json` | No — local only |
| Firebase Auth | Every user's email + password hash | Private (Firebase-managed) |
| Firestore `users/*` | User profiles + roles | Read: self or admin. Write: admin. |
| Firestore `config/coefficients` | Every HVAC / vent / roughness coefficient | Read: active users. Write: admin. |

## Troubleshooting

**"Firebase config isn't valid yet"** → placeholders in `auth.js` weren't replaced (step 2.6).

**"Could not load calculator data"** → `config/coefficients` doc doesn't exist or has wrong shape (step 7).

**"That username doesn't exist"** on login → admin hasn't created the account yet.

**Admin panel says "Failed to load users"** → Firestore rules weren't deployed (step 6), or the signed-in user isn't admin (only FO after first login is admin).
