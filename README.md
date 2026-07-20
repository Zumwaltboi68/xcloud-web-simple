# xCloud Web

A multi-user web client for Xbox Cloud Gaming / console streaming, built
on [`xbox-xcloud-player`](https://github.com/unknownskl/xbox-xcloud-player)
and [`xal-node`](https://www.npmjs.com/package/xal-node). Create an app
account, sign in to your own Xbox account with a Microsoft device code,
then stream your console or Game Pass library from the browser —
keyboard, mouse, and any standard Gamepad-API controller all work,
including fullscreen.

## Auth model (two separate layers)

1. **App account** — the login/register screen you see first. This is
   local to this app: a username + password stored (hashed, never
   plaintext) in `data/users.json`, gating access to the app itself via
   an `express-session` cookie.
2. **Xbox sign-in** — once logged in to the app, you connect your own
   Microsoft account via device code, exactly as before. This writes a
   token file under `data/xbox-sessions/<your-app-username>.json`.

**Each app account's Xbox session is completely isolated** — a real
`TokenManager` instance and token file per app username, not a shared
global. Signing in to Xbox on one app account never exposes or affects
another app account's Xbox session. This is enforced server-side (see
`requireAppLogin` / `attachTokenManager` in `server/index.js`), not just
hidden in the UI.

Registering a new app account is currently open to anyone who can reach
the URL — there's no invite code or admin approval step. If you don't
want that, put the deployment behind IP allowlisting (Render supports
`ipAllowList` in `render.yaml`) or add your own gate in front of
`/account/register`.

**Treat both `data/users.json` and everything under
`data/xbox-sessions/` as credentials.** `.gitignore` already excludes
`data/` entirely — verify with `git status` before your first commit
that nothing under it is staged, and never paste its contents anywhere.


## Local setup

```
npm install
npm start
```

Open http://localhost:3000, sign in, and go.

## Production checklist

Beyond the open-registration note above, before treating a deployment as
"production":

- **Set `SESSION_SECRET`.** `render.yaml` generates one automatically for
  Render deployments (`generateValue: true`). Running elsewhere without
  it falls back to an insecure default and prints a warning on startup —
  set your own before exposing the app anywhere public.
- **Persist `data/` across restarts/redeploys.** Render's filesystem is
  ephemeral by default — without a persistent disk, every redeploy wipes
  `data/users.json` (registered app accounts) and every user's Xbox
  session under `data/xbox-sessions/`. See "Persistence and Render's free
  tier" below for the two ways to handle this. This isn't just
  inconvenience: if the app restarts mid-stream because of a lost token
  file, that's a dropped connection for whoever's playing.
- **Set `NODE_ENV=production`** (already in `render.yaml`) — Node and
  Express libraries commonly branch on this for things like disabling
  verbose error output, and this app's session cookie is only marked
  `secure` when this is set. Render sets this for you by default on
  deploy, but it's pinned explicitly in `render.yaml` here so it doesn't
  depend on that default.
- **Watch for upstream library changes.** Two runtime patches in
  `public/app.js` (`patchInputQueueBug`, `patchAuthorizationWipe`) work
  around real bugs in `xbox-xcloud-player`'s internals by monkey-patching
  its classes after construction. They were verified against the
  package's source at the time this was built — an update to that
  package could silently change or remove the methods being patched,
  and the failure mode is quiet (input just stops working, no error
  thrown) rather than loud. If you bump the `xbox-xcloud-player` version
  and gamepad/keyboard input stops reaching the game, that's the first
  thing to check — re-verify the patches still apply against the new
  version's source before assuming they do.
- **The Game Pass catalog depends on an undocumented Microsoft
  endpoint** (`/v2/titles` on the xCloud host, plus
  `displaycatalog.mp.microsoft.com` for box art — see "Game Pass catalog"
  below). Neither has a stability guarantee. The "Launch by Title ID"
  fallback under the catalog grid doesn't depend on either and will keep
  working even if the catalog grid itself breaks.
- **Restart behavior**: if a user's Xbox token file is present but stale/
  revoked (e.g. they changed their Microsoft password, or the Xbox Live
  session expired in a way `xal-node`'s automatic refresh can't recover
  from), the server logs the failure and serves a "not authenticated"
  status for that account rather than crashing — they'll need to sign in
  again through the UI, no restart required, and it doesn't affect any
  other app account.

## Persistence and Render's free tier

Render's free tier filesystem doesn't survive redeploys or restarts —
`data/users.json` (registered app accounts) and every file under
`data/xbox-sessions/` (each account's Xbox tokens) both live on local
disk with no built-in backup. `render.yaml`'s own comments document this
same tradeoff. Two ways to handle it:

- **Persistent disk** (recommended if you'll redeploy often): add a
  [Render disk](https://render.com/docs/disks) mounted at e.g. `/data`,
  and update `DATA_DIR` in `server/index.js` to point at it via an env
  var instead of the hardcoded `path.join(__dirname, '..', 'data')`.
- **Export backup / Restore backup** (no paid disk needed): click
  "Export backup" in the library screen's topbar *before* a redeploy —
  it downloads one file containing your account (username + password,
  hashed) *and* your Xbox session together. After a redeploy wipes
  `data/`, use the "Restore backup" tab on the login screen (works
  without logging in first, since your account no longer exists at that
  point) to recreate the exact same account and reconnect the same Xbox
  session in one step — no re-registering under a new username, no
  redoing the Microsoft device-code sign-in.

  The older "Export Xbox session only" / "Import Xbox session only"
  buttons still exist too, for the narrower case of moving an Xbox
  connection between two accounts you already control — those don't
  touch account identity and still require being logged in first.

## Deploying to Render

Both app registration and Xbox sign-in happen through the deployed app
itself — no local terminal step needed. `render.yaml` sets up the
service (`npm install` build, `npm start`, `NODE_ENV=production`,
auto-generated `SESSION_SECRET`).

See "Persistence and Render's free tier" above for what happens to
`data/` across redeploys, and your two options for handling it.

## Controls

The keyboard layout is the library's own default
(`src/input/gamepad.ts`, `enable_keyboard: true`):

A = Enter, B = Backspace, X = x, Y = y, D-pad = arrow keys,
LB/RB = `[` `]`, LT/RT = `-` `=`, View = v, Menu = m, Xbox button = n.

Any standard Gamepad-API controller is auto-detected with no
configuration and takes priority when connected. A fullscreen button
sits in the stream HUD; the HUD itself auto-hides after a couple seconds
of inactivity while fullscreen.

## Game Pass catalog

The library screen shows your **actual entitled** Game Pass titles with
box art, pulled from `GET /v2/titles` on the same authenticated xCloud
host `ApiClient` already uses (same token, no separate credential). Box
art comes from a second, unauthenticated lookup against
`displaycatalog.mp.microsoft.com`. Neither is an officially documented,
stability-guaranteed API — if the grid ever comes up empty with a
"could not load your Game Pass catalog" message, that's the most likely
cause. The "Launch by Title ID instead" field under the grid bypasses
both and always works as long as `ApiClient.startStream()` itself does.

Successful fetches are cached server-side for 10 minutes
(`CATALOG_CACHE_MS` in `server/index.js`) and a stale result is served
rather than an empty grid if a refresh fails.

## Known limitations

- **App registration is open to anyone who can reach the URL** — there's
  no invite code, email verification, or admin approval. Each account's
  Xbox session is still fully isolated once created (see "Auth model"
  above), but nothing stops a stranger from creating an app account of
  their own if the URL is public. Add IP allowlisting or your own gate in
  front of `/account/register` if that's not acceptable.
- **Sessions are in-memory** (`express-session`'s default `MemoryStore`)
  — logins don't survive a server restart, and this won't scale correctly
  across more than one server instance/process. Fine for a single Render
  free-tier instance; would need a real session store (e.g.
  `connect-redis`) for anything bigger.
- **Region/host selection** (`getDefaultRegion()` on what
  `xal-node`'s `Msal.getStreamingTokens()` returns) is used as-is from
  the library's response, not independently verified against every
  account type or country.
- **Two runtime patches on third-party library internals**
  (`patchInputQueueBug`, `patchAuthorizationWipe` in `public/app.js`) —
  see "Watch for upstream library changes" above.
