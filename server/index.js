// server/index.js
//
// Modeled closely on xbox-xcloud-player's own src/bin/server.ts (read
// directly from the package source before writing this — not guessed).
// That file already does the token exchange and API proxying correctly;
// this adapts it to serve our UI instead of the library's demo page, and
// to stay up (rather than process.exit()) if auth hasn't been run yet,
// since this runs continuously on Render rather than just locally.
//
// Auth model: multi-user. Each *app* account (created via the
// login/register screen) gets its own, completely separate Xbox sign-in
// and its own token file under data/xbox-sessions/. One person's Xbox
// session is never visible to or usable by another app account. See
// README.md "Persistence and Render's free tier" for why the
// Export/Import Xbox session buttons exist.

require('dotenv').config()
const express = require('express')
const session = require('express-session')
const bodyParser = require('body-parser')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { TokenStore, Xal, Msal } = require('xal-node')
const xCloudPlayer = require('xbox-xcloud-player')

// xbox-xcloud-player ships as a transpiled ES module, so under CommonJS
// `require()` its named exports (ApiClient, Player, etc.) land on a
// `.default` wrapper instead of directly on module.exports. Fall back to
// the top-level export too, in case a future/older build changes that.
const ApiClient = xCloudPlayer.ApiClient || xCloudPlayer.default?.ApiClient

if (typeof ApiClient !== 'function') {
  throw new Error(
    '[fatal] Could not find ApiClient constructor in the xbox-xcloud-player ' +
    'package. Its export shape may have changed — run ' +
    '`node -e "console.log(require(\'xbox-xcloud-player\'))"` to inspect it.'
  )
}

const app = express()
const PORT = process.env.PORT || 3000

const DATA_DIR = path.join(__dirname, '..', 'data')
const USERS_FILE = path.join(DATA_DIR, 'users.json')
const XBOX_SESSIONS_DIR = path.join(DATA_DIR, 'xbox-sessions')

fs.mkdirSync(XBOX_SESSIONS_DIR, { recursive: true })

app.use(bodyParser.json({ limit: '2mb' })) // session import files are small, but give some headroom
app.disable('x-powered-by')
app.set('trust proxy', 1) // Render sits behind a proxy; needed for secure cookies to work correctly

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-only-insecure-secret-change-me',
  name: 'xcloud.sid',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
  }
}))

if (!process.env.SESSION_SECRET) {
  console.warn(
    '[warn] SESSION_SECRET is not set — using an insecure default. ' +
    'Sessions will not survive a server restart in a way that stays ' +
    'secure. Set SESSION_SECRET in your environment (render.yaml already ' +
    'does this for Render deployments via generateValue: true).'
  )
}

// -----------------------------------------------------------------------
// App accounts — separate from Xbox sign-in. This just gates access to
// the app itself; Xbox auth (below) is scoped per app-account on top of
// this. Passwords are hashed with Node's built-in scrypt (no extra
// dependency needed) — never stored or logged in plain text.
// -----------------------------------------------------------------------

function loadUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) return {}
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'))
  } catch (err) {
    console.error('[users] Failed to read users.json, treating as empty:', err)
    return {}
  }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2))
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex')
  return { salt, hash }
}

function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt)
  const a = Buffer.from(hash, 'hex')
  const b = Buffer.from(expectedHash, 'hex')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

const USERNAME_PATTERN = /^[a-zA-Z0-9_-]{3,32}$/

function safeUsernameToFilename(username) {
  // Usernames are already restricted to USERNAME_PATTERN at registration,
  // so this is a defense-in-depth check, not the primary validation.
  if (!USERNAME_PATTERN.test(username)) {
    throw new Error('Invalid username.')
  }
  return path.join(XBOX_SESSIONS_DIR, `${username}.json`)
}

function requireAppLogin(req, res, next) {
  if (!req.session?.username) {
    res.status(401).json({ error: 'Not logged in.' })
    return
  }
  next()
}



// -----------------------------------------------------------------------
// Token manager — same shape as the library's own xHomeTokenManager, now
// parameterized per app-user so each account's Xbox session is completely
// isolated on disk (data/xbox-sessions/<username>.json) and in memory.
// -----------------------------------------------------------------------

class TokenManager {
  constructor(tokenFilePath) {
    this.tokenFilePath = tokenFilePath
    this.tokenStore = new TokenStore()
    this.tokenStore.load(tokenFilePath, true)
    this.xal = new Xal(this.tokenStore)
    this.msal = new Msal(this.tokenStore)

    this.apiClientHome = undefined
    this.apiClientCloud = undefined
    this.ready = false
    this.lastError = undefined
    this.deviceCodeState = null // { device_code, expires_at }
  }

  load() {
    if (this.tokenStore.getAuthenticationMethod() === 'none') {
      this.lastError = 'Not signed in yet.'
      return
    }

    this._requestTokens()
      .then((tokens) => {
        const tokenxHome = tokens.xHomeToken?.data?.gsToken
        const tokenxCloud = tokens.xCloudToken?.data?.gsToken

        if (tokenxHome) {
          console.log('[auth] xHome (console) streaming is available.')
          this.apiClientHome = new ApiClient({
            host: tokens.xHomeToken.getDefaultRegion().baseUri,
            token: tokenxHome
          })
        } else {
          console.log('[auth] xHome (console) streaming is not available on this account.')
        }

        if (tokenxCloud) {
          console.log('[auth] xCloud (Game Pass) streaming is available.')
          this.apiClientCloud = new ApiClient({
            host: tokens.xCloudToken.getDefaultRegion().baseUri,
            token: tokenxCloud
          })
        } else {
          console.log('[auth] xCloud (Game Pass) streaming is not available on this account.')
        }

        this.ready = true
        console.log('[auth] Ready. Streaming tokens loaded.')
      })
      .catch((err) => {
        this.lastError = String(err?.message || err)
        console.error(
          '[auth] Failed to load streaming tokens after sign-in. ' +
          'Try signing out and signing in again. Error:', err
        )
      })
  }

  _requestTokens() {
    if (this.tokenStore.getAuthenticationMethod() === 'msal') {
      return this.msal.getStreamingTokens()
    }
    return this.xal.getStreamingTokens()
  }

  getMsalToken() {
    if (this.tokenStore.getAuthenticationMethod() === 'msal') {
      return this.msal.getMsalToken()
    }
    return this.xal.getMsalToken()
  }
}

// One TokenManager per app username, created on first use and cached for
// the life of the process. Safe as a plain in-memory Map: each instance's
// actual state is backed by its own file on disk, so nothing here is lost
// beyond what disk persistence already limits (see README re: Render's
// free tier wiping local disk on restart).
const tokenManagers = new Map()

function getTokenManager(username) {
  let manager = tokenManagers.get(username)
  if (!manager) {
    manager = new TokenManager(safeUsernameToFilename(username))
    manager.load()
    tokenManagers.set(username, manager)
  }
  return manager
}



// -----------------------------------------------------------------------
// Device-code sign-in — verified against xal-node's own src/msal.ts:
//   doDeviceCodeAuth()              -> { user_code, verification_uri, ... }
//   doPollForDeviceCodeAuth(code)   -> resolves once the user finishes
//                                      signing in at that URL; writes the
//                                      token to the store internally.
// verification_uri from Microsoft's device-code endpoint is
// microsoft.com/link, so this is literally "generate a code, enter it
// there" — no extra work needed to match that.
//
// Everything here now operates on whichever app user is logged in for
// this request (req.session.username), via getTokenManager(), instead of
// a single global TokenManager — that's the actual multi-user boundary.
// -----------------------------------------------------------------------

// Attach the logged-in app user's TokenManager to the request once,
// after app-login is confirmed, so every route below just reads
// req.tokenManager instead of re-deriving it.
function attachTokenManager(req, res, next) {
  req.tokenManager = getTokenManager(req.session.username)
  next()
}

app.post('/auth/start', requireAppLogin, attachTokenManager, (req, res) => {
  const manager = req.tokenManager

  if (manager.tokenStore.getAuthenticationMethod() !== 'none') {
    res.status(400).json({ error: 'Already signed in. Sign out first if you want to switch accounts.' })
    return
  }

  manager.msal.doDeviceCodeAuth()
    .then((flow) => {
      manager.deviceCodeState = {
        device_code: flow.device_code,
        expires_at: Date.now() + flow.expires_in * 1000
      }

      res.json({
        user_code: flow.user_code,
        verification_uri: flow.verification_uri,
        expires_in: flow.expires_in,
        interval: flow.interval
      })

      // Poll in the background. doPollForDeviceCodeAuth already retries
      // internally every second until timeout, so we just await it once.
      manager.msal.doPollForDeviceCodeAuth(flow.device_code, flow.expires_in * 1000)
        .then(() => {
          console.log(`[auth] Device code sign-in complete for "${req.session.username}". Loading streaming tokens…`)
          manager.deviceCodeState = null
          manager.load()
        })
        .catch((err) => {
          console.error(`[auth] Device code sign-in failed or expired for "${req.session.username}":`, err)
          manager.deviceCodeState = null
        })
    })
    .catch((err) => {
      console.error('[auth/start] error:', err)
      res.status(500).json({ error: String(err?.message || err) })
    })
})

app.post('/auth/signout', requireAppLogin, attachTokenManager, (req, res) => {
  const manager = req.tokenManager
  manager.tokenStore.removeAll()
  manager.ready = false
  manager.apiClientHome = undefined
  manager.apiClientCloud = undefined
  manager.lastError = undefined
  res.json({ ok: true })
})

function clientFor(tokenManager, reqPath) {
  return reqPath.includes('/cloud/') ? tokenManager.apiClientCloud : tokenManager.apiClientHome
}

function requireAuth(req, res, next) {
  if (!req.tokenManager?.ready) {
    res.status(503).json({
      error: req.tokenManager?.lastError
        ? `Not authenticated: ${req.tokenManager.lastError}`
        : 'Still loading Xbox streaming tokens, try again in a moment.'
    })
    return
  }
  next()
}

// -----------------------------------------------------------------------
// Static assets: our UI, plus the library's own prebuilt browser bundle
// (node_modules/xbox-xcloud-player/dist/assets/xCloudPlayer.min.js) —
// no bundler step of our own needed, we serve their compiled output
// directly, exposing window.xCloudPlayer with the same shape as the
// Node import.
// -----------------------------------------------------------------------

app.use(express.static(path.join(__dirname, '..', 'public')))
app.use(
  '/vendor',
  express.static(path.join(__dirname, '..', 'node_modules', 'xbox-xcloud-player', 'dist', 'assets'))
)

// -----------------------------------------------------------------------
// App account routes — register/login/logout gate access to the app
// itself; everything Xbox-related above and below this point is scoped
// to whichever app account is currently logged in.
// -----------------------------------------------------------------------

app.post('/account/register', (req, res) => {
  const { username, password } = req.body || {}

  if (typeof username !== 'string' || !USERNAME_PATTERN.test(username)) {
    res.status(400).json({ error: '3-32 characters: letters, numbers, underscore, or hyphen.' })
    return
  }
  if (typeof password !== 'string' || password.length < 8) {
    res.status(400).json({ error: 'Password must be at least 8 characters.' })
    return
  }

  const users = loadUsers()
  if (users[username]) {
    res.status(409).json({ error: 'That username is already taken.' })
    return
  }

  const { salt, hash } = hashPassword(password)
  users[username] = { salt, hash, createdAt: new Date().toISOString() }
  saveUsers(users)

  req.session.username = username
  res.json({ username })
})

app.post('/account/login', (req, res) => {
  const { username, password } = req.body || {}

  if (typeof username !== 'string' || typeof password !== 'string') {
    res.status(400).json({ error: 'Username and password are required.' })
    return
  }

  const users = loadUsers()
  const record = users[username]

  // Deliberately vague error for both "no such user" and "wrong
  // password" — distinguishing them lets an attacker enumerate valid
  // usernames.
  if (!record || !verifyPassword(password, record.salt, record.hash)) {
    res.status(401).json({ error: 'Incorrect username or password.' })
    return
  }

  req.session.username = username
  res.json({ username })
})

app.get('/account/me', (req, res) => {
  if (!req.session?.username) {
    res.json({ loggedIn: false })
    return
  }
  res.json({ loggedIn: true, username: req.session.username })
})

app.post('/account/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('xcloud.sid')
    res.json({ ok: true })
  })
})

// -----------------------------------------------------------------------
// Full account backup / restore — this is the actual fix for "what good
// is exporting my Xbox session if a wiped data/ also deletes my account,
// so I have to register a NEW username before I can even see the import
// button." The export now bundles the account (username + password hash)
// together with the Xbox token file, and restore-backup works from the
// logged-out account screen, before any login/registration — it recreates
// the original account rather than requiring a fresh one first.
//
// Backward compatibility: the older export format (just the raw xal-node
// token store JSON, no account info) is still accepted by
// /account/import-xbox-session below for anyone who saved one of those
// before this change, and that route still requires being logged in
// first, since it only ever touched Xbox tokens, never account identity.
// -----------------------------------------------------------------------

const BACKUP_KIND = 'xcloud-web-full-backup-v1'

app.get('/account/export-backup', requireAppLogin, attachTokenManager, (req, res) => {
  const username = req.session.username
  const users = loadUsers()
  const userRecord = users[username]

  if (!userRecord) {
    // Shouldn't happen (you can't be logged in without a users.json
    // entry), but don't crash if data/users.json was edited by hand.
    res.status(500).json({ error: 'Could not find your account record to back up.' })
    return
  }

  const manager = req.tokenManager
  let xboxSession = {}
  if (manager.tokenStore.getAuthenticationMethod() !== 'none' && fs.existsSync(manager.tokenFilePath)) {
    try {
      xboxSession = JSON.parse(fs.readFileSync(manager.tokenFilePath, 'utf8'))
    } catch (err) {
      console.error('[export-backup] Could not read/parse Xbox session file, exporting without it:', err)
    }
  }

  const backup = {
    kind: BACKUP_KIND,
    username,
    passwordSalt: userRecord.salt,
    passwordHash: userRecord.hash,
    xboxSession,
    exportedAt: new Date().toISOString()
  }

  const filename = `xcloud-web-backup-${username}.json`
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.send(JSON.stringify(backup, null, 2))
})

// No requireAppLogin here on purpose — this is how you get an account
// back after data/ was wiped, which by definition means you can't log in
// yet.
app.post('/account/restore-backup', (req, res) => {
  const { fileContents } = req.body || {}
  if (typeof fileContents !== 'string' || fileContents.trim().length === 0) {
    res.status(400).json({ error: 'No file contents received.' })
    return
  }

  let parsed
  try {
    parsed = JSON.parse(fileContents)
  } catch (err) {
    res.status(400).json({ error: 'That file is not valid JSON — is it really a backup file?' })
    return
  }

  if (!parsed || parsed.kind !== BACKUP_KIND) {
    res.status(400).json({
      error: 'That doesn\u2019t look like a full backup file. Use "Export backup" from the library screen to make one — the older "Export session" format only restores Xbox tokens, not the account itself.'
    })
    return
  }

  const { username, passwordSalt, passwordHash, xboxSession } = parsed
  if (typeof username !== 'string' || !USERNAME_PATTERN.test(username) ||
      typeof passwordSalt !== 'string' || typeof passwordHash !== 'string') {
    res.status(400).json({ error: 'That backup file is missing required account fields.' })
    return
  }

  const users = loadUsers()
  if (users[username]) {
    res.status(409).json({
      error: `An account named "${username}" already exists. If that's you, log in normally instead — restore is only for recreating an account that no longer exists.`
    })
    return
  }

  try {
    users[username] = {
      salt: passwordSalt,
      hash: passwordHash,
      createdAt: parsed.exportedAt || new Date().toISOString(),
      restoredAt: new Date().toISOString()
    }
    saveUsers(users)

    if (xboxSession && typeof xboxSession === 'object' && Object.keys(xboxSession).length > 0) {
      const tokenFilePath = safeUsernameToFilename(username)
      fs.writeFileSync(tokenFilePath, JSON.stringify(xboxSession, null, 2))
      const manager = new TokenManager(tokenFilePath)
      manager.load()
      tokenManagers.set(username, manager)
    }

    req.session.username = username
    res.json({ username })
  } catch (err) {
    console.error('[restore-backup] error:', err)
    res.status(500).json({ error: 'Could not restore that backup.' })
  }
})

// -----------------------------------------------------------------------
// Xbox-session-only export/import (older, narrower mechanism) — still
// useful if you just want to move an Xbox connection between two
// accounts you already control, without touching account identity at
// all. Requires being logged in already, unlike restore-backup above.
// -----------------------------------------------------------------------

app.get('/account/export-xbox-session', requireAppLogin, attachTokenManager, (req, res) => {
  const manager = req.tokenManager
  if (manager.tokenStore.getAuthenticationMethod() === 'none') {
    res.status(400).json({ error: 'Nothing to export — you have not signed in to Xbox yet.' })
    return
  }

  if (!fs.existsSync(manager.tokenFilePath)) {
    res.status(404).json({ error: 'No session file found on disk for this account.' })
    return
  }

  const contents = fs.readFileSync(manager.tokenFilePath, 'utf8')
  const filename = `xcloud-web-session-${req.session.username}.json`
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.send(contents)
})

app.post('/account/import-xbox-session', requireAppLogin, attachTokenManager, (req, res) => {
  const { fileContents } = req.body || {}
  if (typeof fileContents !== 'string' || fileContents.trim().length === 0) {
    res.status(400).json({ error: 'No file contents received.' })
    return
  }

  let parsed
  try {
    parsed = JSON.parse(fileContents)
  } catch (err) {
    res.status(400).json({ error: 'That file is not valid JSON — is it really an exported session?' })
    return
  }

  // Someone might drag in a full backup file here by mistake — point
  // them at the right button instead of silently importing only the
  // xboxSession sub-object (which would work, but hides that a fuller
  // restore-backup option exists and is probably what they wanted).
  if (parsed && parsed.kind === BACKUP_KIND) {
    res.status(400).json({
      error: 'That\u2019s a full account backup file, not a plain Xbox session export. Log out and use "Restore backup" on the login screen instead.'
    })
    return
  }

  // Minimal shape check: a real export always has at least one of these
  // keys once signed in (see xal-node's TokenStore.loadJson). An empty
  // {} is technically valid (a signed-out export) but importing one
  // would just sign the user back out, which is a legitimate no-op.
  const looksLikeTokenStore =
    parsed && typeof parsed === 'object' &&
    ('userToken' in parsed || 'sisuToken' in parsed || 'jwtKeys' in parsed || Object.keys(parsed).length === 0)

  if (!looksLikeTokenStore) {
    res.status(400).json({ error: 'That file does not look like an exported Xbox session.' })
    return
  }

  try {
    const manager = req.tokenManager
    fs.writeFileSync(manager.tokenFilePath, JSON.stringify(parsed, null, 2))
    // Rebuild the manager fresh from the new file rather than mutating
    // the live one in place, so stale in-memory state (old ApiClient
    // instances, old ready/lastError flags) can't linger.
    const fresh = new TokenManager(manager.tokenFilePath)
    fresh.load()
    tokenManagers.set(req.session.username, fresh)
    res.json({ ok: true })
  } catch (err) {
    console.error('[import-xbox-session] error:', err)
    res.status(500).json({ error: 'Could not save that session file.' })
  }
})

app.get('/api/status', requireAppLogin, attachTokenManager, (req, res) => {
  const manager = req.tokenManager
  res.json({
    ready: manager.ready,
    home: !!manager.apiClientHome,
    cloud: !!manager.apiClientCloud,
    error: manager.lastError || null,
    signedIn: manager.tokenStore.getAuthenticationMethod() !== 'none',
    awaitingDeviceCode: manager.deviceCodeState !== null
  })
})

// -----------------------------------------------------------------------
// Game Pass catalog — the account's actual entitled/owned titles, for the
// "browse and launch" grid on the library screen.
//
// CORRECTED from an earlier version of this file: that version pulled a
// public, unauthenticated "all Game Pass games" list from
// catalog.gamepass.com/sigls + displaycatalog.mp.microsoft.com, and used
// each title's numeric XboxTitleId (AlternateIds -> "XboxTitleId") as the
// launch id. That numeric id is NOT what ApiClient.startStream('cloud',
// titleId) expects — confirmed by comparing it against real working
// manual title IDs (e.g. "HALOMCC", "CALLOFDUTYBLACKOPS6"), which are
// short alias/slug strings, not numbers. That's why clicking a catalog
// tile failed while typing a Title ID manually worked.
//
// The correct source (found via Geocld/XStreaming's documented xCloud
// web API, cross-checked against real working title IDs from this app's
// own use) is xCloud's own entitled-titles endpoint:
//
//   GET {gssv host}/v2/titles
//   Authorization: Bearer <gsToken>          (same token ApiClient already holds)
//   -> { results: [ { titleId: "HALOINFINITE", details: { productId, xboxTitleId, hasEntitlement, ... } } ] }
//
// `titleId` here IS the correct slug string startStream() wants, and this
// endpoint only returns titles tied to the signed-in account (i.e. your
// actual library), not the entire public Game Pass catalog. Box art still
// comes from displaycatalog.mp.microsoft.com, but now keyed off the
// correct `details.productId` for each entitled title rather than a
// mismatched public-catalog id.
// -----------------------------------------------------------------------

const CATALOG_MARKET = 'US'
const CATALOG_LANGUAGE = 'en-us'

const CATALOG_CACHE_MS = 10 * 60 * 1000 // 10 minutes — live, but not hammering Microsoft per page load

async function fetchBoxArt(productIds) {
  const artByProductId = {}
  if (productIds.length === 0) return artByProductId

  const chunks = []
  for (let i = 0; i < productIds.length; i += 20) chunks.push(productIds.slice(i, i + 20))

  for (const chunk of chunks) {
    try {
      const productsUrl = `https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=${chunk.join(',')}&market=${CATALOG_MARKET}&languages=${CATALOG_LANGUAGE}`
      const productsRes = await fetch(productsUrl)
      if (!productsRes.ok) continue // skip a bad chunk rather than fail the whole list
      const productsData = await productsRes.json()

      for (const product of productsData.Products || []) {
        const localized = product.LocalizedProperties?.[0]
        if (!localized) continue

        const images = localized.Images || []
        const boxArt =
          images.find((img) => /box ?art/i.test(img.ImagePurpose || '')) ||
          images.find((img) => /poster/i.test(img.ImagePurpose || '')) ||
          images[0]

        artByProductId[product.ProductId] = {
          title: localized.ProductTitle,
          publisher: localized.PublisherName || '',
          imageUrl: boxArt?.Uri ? (boxArt.Uri.startsWith('//') ? 'https:' + boxArt.Uri : boxArt.Uri) : null
        }
      }
    } catch (err) {
      console.error('[catalog] Box art chunk failed (continuing without it for these titles):', err)
    }
  }

  return artByProductId
}

async function fetchGamePassCatalog(tokenManager) {
  const client = tokenManager.apiClientCloud
  if (!client) {
    throw new Error('This account has no Game Pass / xCloud streaming client — cloud catalog unavailable.')
  }

  const response = await client.get('/v2/titles')
  const results = response?.results || []

  const entitled = results.filter((r) => r.details?.hasEntitlement !== false && r.titleId)
  const productIds = entitled.map((r) => r.details?.productId).filter(Boolean)
  const artByProductId = await fetchBoxArt(productIds)

  return entitled.map((r) => {
    const art = artByProductId[r.details?.productId] || {}
    return {
      titleId: r.titleId, // the real launchable id — confirmed against your own working manual IDs
      productId: r.details?.productId || null,
      title: art.title || r.titleId,
      publisher: art.publisher || '',
      imageUrl: art.imageUrl || null
    }
  })
}

// Keyed per app username — a global cache would leak one account's
// Game Pass library into another account's grid.
const catalogCacheByUser = new Map() // username -> { at, games }

app.get('/api/catalog', requireAppLogin, attachTokenManager, requireAuth, async (req, res) => {
  const username = req.session.username
  const now = Date.now()
  const cached = catalogCacheByUser.get(username)

  if (cached && cached.games.length > 0 && now - cached.at < CATALOG_CACHE_MS) {
    res.json({ games: cached.games, cached: true })
    return
  }

  try {
    const games = await fetchGamePassCatalog(req.tokenManager)
    catalogCacheByUser.set(username, { at: now, games })
    res.json({ games, cached: false })
  } catch (err) {
    console.error(`[catalog] Failed to fetch Game Pass catalog for "${username}":`, err)
    if (cached && cached.games.length > 0) {
      // Serve stale data rather than an empty grid if Microsoft's
      // endpoint hiccups.
      res.json({ games: cached.games, cached: true, stale: true })
    } else {
      res.status(502).json({ error: 'Could not load your Game Pass catalog right now.' })
    }
  }
})

// Used by the frontend's chat-audio SDP renegotiation, same as the
// library's own example (src/example/stream.ts: fetch('/api/msal')).
app.get('/api/msal', requireAppLogin, attachTokenManager, requireAuth, (req, res) => {
  req.tokenManager.getMsalToken()
    .then((result) => res.send(result.data.lpt))
    .catch((err) => {
      console.error('[api/msal] error:', err)
      res.status(500).json({ error: String(err?.message || err) })
    })
})

app.get(['/v6/*splat', '/v5/*splat'], requireAppLogin, attachTokenManager, requireAuth, (req, res) => {
  const client = clientFor(req.tokenManager, req.path)
  if (!client) {
    res.status(400).json({ error: 'This account has no client for that streaming type.' })
    return
  }
  client.get(req.path, {}).then((result) => res.send(result)).catch((err) => {
    console.error('[proxy GET] error:', req.path, err)
    res.status(500).json(err)
  })
})

app.post(['/v6/*splat', '/v5/*splat'], requireAppLogin, attachTokenManager, requireAuth, (req, res) => {
  const client = clientFor(req.tokenManager, req.path)
  if (!client) {
    res.status(400).json({ error: 'This account has no client for that streaming type.' })
    return
  }
  const deviceInfoHeader = req.header('x-ms-device-info')
  client
    .post(req.path, JSON.stringify(req.body), deviceInfoHeader ? { 'x-ms-device-info': deviceInfoHeader } : {})
    .then((result) => res.send(result))
    .catch((err) => {
      console.error('[proxy POST] error:', req.path, err)
      res.status(500).json(err)
    })
})

app.delete(['/v6/*splat', '/v5/*splat'], requireAppLogin, attachTokenManager, requireAuth, (req, res) => {
  const client = clientFor(req.tokenManager, req.path)
  if (!client) {
    res.status(400).json({ error: 'This account has no client for that streaming type.' })
    return
  }
  client.delete(req.path, {}).then((result) => res.send(result)).catch((err) => {
    console.error('[proxy DELETE] error:', req.path, err)
    res.status(500).json(err)
  })
})

app.listen(PORT, () => {
  console.log(`xcloud-web listening on :${PORT}`)
})
