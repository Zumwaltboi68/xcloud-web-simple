// public/app.js
//
// This is deliberately close to xbox-xcloud-player's own
// src/example/stream.ts, which I read from the actual package source
// before writing this — the SDP/ICE dance, event names, and Gamepad
// attach call are copied from a verified working reference, not guessed.

// The prebuilt bundle (/vendor/xCloudPlayer.min.js) assigns
// `var xCloudPlayer = <transpiled module exports>`, and like the Node
// package, its transpiled output nests the real named exports (ApiClient,
// Player, Gamepad, MouseKeyboard, Touch) under a `.default` wrapper
// instead of putting them directly on the object. Unwrap once here so the
// rest of this file can keep using the flat `xCloudPlayer.ApiClient` etc.
// shape it was written against.
const xCloudPlayerLib = window.xCloudPlayer?.ApiClient
  ? window.xCloudPlayer
  : window.xCloudPlayer?.default

if (!xCloudPlayerLib || typeof xCloudPlayerLib.ApiClient !== 'function') {
  console.error('[xcloud-web] Could not find ApiClient on the xCloudPlayer bundle. Its export shape may have changed.')
}

const $ = (id) => document.getElementById(id)

// ---------------------------------------------------------------------
// Boot sequence — purely presentational, runs independently of the real
// app logic below (checkStatus() etc. still kicks off immediately and
// runs in parallel underneath; the boot screen just sits on top at a
// higher z-index until its timer/skip fires). Timings here are the JS
// half of the CSS animation timeline in style.css — the CSS drives the
// visuals, this only decides when to remove the overlay.
// ---------------------------------------------------------------------

;(function bootSequence() {
  const screen = $('boot-screen')
  if (!screen) return

  const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  // Full sequence's last one-shot beat (the second, bigger ignite pulse
  // once every status line has reported in) ends at 9.2s — see the
  // .boot-ignite-2 rule in style.css. Reduced-motion strips the
  // animations to instant end-states via CSS, so there's nothing to
  // wait for; a short pause is just enough to not feel like a jarring
  // skip straight past the logo.
  const HOLD_MS = prefersReducedMotion ? 500 : 9200
  const EXIT_TRANSITION_MS = 500

  let exited = false

  function exitBoot() {
    if (exited) return
    exited = true
    screen.classList.add('boot-exit')
    setTimeout(() => {
      screen.classList.add('boot-done')
      screen.setAttribute('aria-hidden', 'true')
    }, EXIT_TRANSITION_MS)
  }

  const holdTimer = setTimeout(exitBoot, HOLD_MS)

  $('boot-skip')?.addEventListener('click', () => {
    clearTimeout(holdTimer)
    exitBoot()
  })

  document.addEventListener('keydown', function skipOnEscape(e) {
    if (e.key === 'Escape' && !exited) {
      clearTimeout(holdTimer)
      exitBoot()
      document.removeEventListener('keydown', skipOnEscape)
    }
  })
})()

const screens = {
  account: $('screen-account'),
  signin: $('screen-signin'),
  status: $('screen-status'),
  library: $('screen-library'),
  stream: $('screen-stream')
}

function showScreen(name) {
  for (const key of Object.keys(screens)) {
    screens[key].classList.toggle('hidden', key !== name)
  }
}

// ---------------------------------------------------------------------
// Toasts — transient confirmations only (code copied, signed out,
// catalog refreshed). Blocking/persistent errors stay as inline .error
// text next to their source rather than a toast, since a toast that
// auto-dismisses is the wrong fit for something the person still needs
// to act on.
// ---------------------------------------------------------------------

function showToast(message, { error = false, duration = 3200 } = {}) {
  const stack = $('toast-stack')
  if (!stack) return

  const toast = document.createElement('div')
  toast.className = 'toast' + (error ? ' toast-error' : '')
  toast.textContent = message
  stack.appendChild(toast)

  setTimeout(() => {
    toast.classList.add('leaving')
    toast.addEventListener('animationend', () => toast.remove(), { once: true })
  }, duration)
}

// ---------------------------------------------------------------------
// Sign-in (device code flow) — verified against xal-node's src/msal.ts:
// doDeviceCodeAuth()/doPollForDeviceCodeAuth() on the server side. The
// verification_uri Microsoft returns is microsoft.com/link.
// ---------------------------------------------------------------------

async function beginSignIn() {
  $('signin-error').classList.add('hidden')
  $('btn-signin').disabled = true

  try {
    const res = await fetch('/auth/start', { method: 'POST' })
    const flow = await res.json()
    if (!res.ok) throw new Error(flow.error || 'Failed to start sign-in')

    $('signin-idle').classList.add('hidden')
    $('btn-signin').classList.add('hidden')
    $('user-code').textContent = flow.user_code
    $('device-code-box').classList.remove('hidden')

    pollSignIn()
  } catch (err) {
    showSignInError(err.message)
  }
}

function showSignInError(message) {
  $('signin-error').textContent = message
  $('signin-error').classList.remove('hidden')
  $('btn-signin').disabled = false
  $('btn-signin').classList.remove('hidden')
  $('signin-idle').classList.remove('hidden')
  $('device-code-box').classList.add('hidden')
}

async function pollSignIn() {
  try {
    const res = await fetch('/api/status')
    const data = await res.json()

    if (data.signedIn) {
      showScreen('status')
      checkStatus()
      return
    }

    if (!data.awaitingDeviceCode) {
      // The code expired or was declined server-side.
      showSignInError('That code expired or sign-in was cancelled. Try again.')
      return
    }
  } catch (err) {
    // transient network hiccup — keep polling
  }

  setTimeout(pollSignIn, 2000)
}

$('btn-signin').addEventListener('click', beginSignIn)

$('btn-copy-code').addEventListener('click', async () => {
  const code = $('user-code').textContent.trim()
  if (!code) return

  try {
    await navigator.clipboard.writeText(code)
    $('btn-copy-code').classList.add('copied')
    setTimeout(() => $('btn-copy-code').classList.remove('copied'), 1500)
    showToast('Code copied')
  } catch (err) {
    // Clipboard API needs a secure context (https or localhost) and
    // permission — fall back to just telling the person to select it
    // manually rather than failing silently.
    showToast('Could not copy — select the code manually', { error: true })
  }
})

// ---------------------------------------------------------------------
// App account (new, separate from Xbox sign-in above). Log in / create
// account gates access to the app itself; only after that does the
// existing Xbox device-code flow run, scoped to whichever app account
// is currently logged in.
// ---------------------------------------------------------------------

function setFormError(id, message) {
  const el = $(id)
  el.textContent = message
  el.classList.remove('hidden')
}

function clearFormErrors() {
  $('login-error').classList.add('hidden')
  $('register-error').classList.add('hidden')
}

$('tab-login').addEventListener('click', () => {
  $('tab-login').classList.add('active')
  $('tab-login').setAttribute('aria-selected', 'true')
  $('tab-register').classList.remove('active')
  $('tab-register').setAttribute('aria-selected', 'false')
  $('form-login').classList.remove('hidden')
  $('form-register').classList.add('hidden')
  clearFormErrors()
})

$('tab-register').addEventListener('click', () => {
  $('tab-register').classList.add('active')
  $('tab-register').setAttribute('aria-selected', 'true')
  $('tab-login').classList.remove('active')
  $('tab-login').setAttribute('aria-selected', 'false')
  $('form-register').classList.remove('hidden')
  $('form-login').classList.add('hidden')
  clearFormErrors()
})

$('form-login').addEventListener('submit', async (e) => {
  e.preventDefault()
  clearFormErrors()

  const username = $('login-username').value.trim()
  const password = $('login-password').value

  try {
    const res = await fetch('/account/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Log in failed.')

    onAppLoggedIn(data.username)
  } catch (err) {
    setFormError('login-error', err.message)
  }
})

$('form-register').addEventListener('submit', async (e) => {
  e.preventDefault()
  clearFormErrors()

  const username = $('register-username').value.trim()
  const password = $('register-password').value

  try {
    const res = await fetch('/account/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Could not create account.')

    onAppLoggedIn(data.username)
  } catch (err) {
    setFormError('register-error', err.message)
  }
})

function onAppLoggedIn(username) {
  $('topbar-username').textContent = username
  checkStatus()
}

async function checkAppSession() {
  try {
    const res = await fetch('/account/me')
    const data = await res.json()

    if (!data.loggedIn) {
      showScreen('account')
      return
    }

    $('topbar-username').textContent = data.username
    checkStatus()
  } catch (err) {
    // Server unreachable — same treatment the Xbox status check gives
    // a network hiccup, just one layer up.
    showScreen('account')
    setFormError('login-error', 'Could not reach the server. Try again.')
  }
}

$('btn-logout').addEventListener('click', async () => {
  await fetch('/account/logout', { method: 'POST' })
  location.reload()
})

// ---------------------------------------------------------------------
// Xbox session export/import — the actual workaround for Render's free
// tier wiping local disk on every redeploy. The exported file contains
// real Xbox Live tokens; treat it like a password in every user-facing
// string here, not just the docs.
// ---------------------------------------------------------------------

$('btn-export-session').addEventListener('click', async () => {
  try {
    const res = await fetch('/account/export-xbox-session')
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || 'Could not export your session.')
    }

    const blob = await res.blob()
    const disposition = res.headers.get('Content-Disposition') || ''
    const filenameMatch = disposition.match(/filename="([^"]+)"/)
    const filename = filenameMatch ? filenameMatch[1] : 'xcloud-web-session.json'

    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)

    showToast('Session exported — keep this file private, it works like a password')
  } catch (err) {
    showToast(err.message, { error: true })
  }
})

$('btn-import-session').addEventListener('click', () => {
  $('import-session-input').click()
})

$('import-session-input').addEventListener('change', async (e) => {
  const file = e.target.files?.[0]
  e.target.value = '' // reset so selecting the same file again still fires 'change'
  if (!file) return

  const proceed = confirm(
    'This replaces your current Xbox connection with the one in this file. Continue?'
  )
  if (!proceed) return

  try {
    const fileContents = await file.text()
    const res = await fetch('/account/import-xbox-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileContents })
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Could not import that session file.')

    showToast('Session imported')
    checkStatus()
  } catch (err) {
    showToast(err.message, { error: true })
  }
})

// ---------------------------------------------------------------------
// Boot: check whether the server already has valid Xbox tokens loaded.
// ---------------------------------------------------------------------

// Known Xbox Live XSTS error codes (XErr) — confirmed against multiple
// independent reports (Minecraft Wiki, Microsoft Q&A, other launchers
// hitting the same endpoint), not guessed. Each includes the redirect
// Microsoft's own response gives for fixing it.
const KNOWN_XERR = {
  2148916233: {
    text: "This Microsoft account doesn't have an Xbox profile yet.",
    fixText: 'Set one up at xbox.com/live',
    fixUrl: 'https://www.xbox.com/live'
  },
  2148916235: {
    text: 'Xbox Live is not available for this account\u2019s country/region.'
  },
  2148916236: {
    text: 'This account needs adult verification on the Xbox page (South Korea).',
    fixText: 'Verify at xbox.com',
    fixUrl: 'https://www.xbox.com'
  },
  2148916237: {
    text: 'Age verification is required on the Xbox page (South Korea).',
    fixText: 'Verify at xbox.com',
    fixUrl: 'https://www.xbox.com'
  },
  2148916238: {
    text: 'This account is under 18 and needs to be added to a family group by an adult.'
  }
}

function renderStatusError(rawError) {
  let known = null
  try {
    const match = rawError.match(/XErr\\?":\s*(\d+)/)
    if (match) known = KNOWN_XERR[Number(match[1])]
  } catch (e) {
    // fall through to raw display
  }

  if (known) {
    $('status-text').textContent = known.text
    $('status-error').innerHTML = known.fixUrl
      ? `<a href="${known.fixUrl}" target="_blank" rel="noopener">${known.fixText}</a>, then sign out and sign in again.`
      : 'Sign out and sign in again with a different account once resolved.'
  } else {
    $('status-text').textContent = 'Signed in, but failed to load streaming tokens.'
    $('status-error').textContent = rawError
  }
  $('status-error').classList.remove('hidden')
}

async function checkStatus() {
  try {
    const res = await fetch('/api/status')
    const data = await res.json()

    if (!data.signedIn) {
      showScreen('signin')
      return
    }

    if (data.ready) {
      apiClient = new xCloudPlayerLib.ApiClient({ host: window.location.origin })
      await loadConsoles()
      showScreen('library')
      loadCatalog()
      return
    }

    showScreen('status')
    if (data.error) {
      renderStatusError(data.error)
    } else {
      $('status-text').textContent = 'Loading Xbox streaming tokens…'
      $('status-error').classList.add('hidden')
    }
    setTimeout(checkStatus, 2000)
  } catch (err) {
    showScreen('status')
    $('status-text').textContent = 'Could not reach the server.'
    $('status-error').textContent = err.message
    $('status-error').classList.remove('hidden')
    setTimeout(checkStatus, 3000)
  }
}

$('btn-signout').addEventListener('click', async () => {
  await fetch('/auth/signout', { method: 'POST' })
  location.reload()
})

// ---------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------

let apiClient = null

async function loadConsoles() {
  const grid = $('console-list')
  try {
    const consoles = await apiClient.getConsoles()
    grid.innerHTML = ''

    if (!consoles.results || consoles.results.length === 0) {
      grid.innerHTML = '<p class="muted small">No consoles found on this account.</p>'
      return
    }

    for (const c of consoles.results) {
      const tile = document.createElement('div')
      const offline = c.powerState !== 'On'
      tile.className = 'console-tile' + (offline ? ' offline' : '')
      tile.innerHTML = `<h3>${c.deviceName}</h3><p class="status-row muted small"><span class="status-dot"></span>${c.consoleType} — ${c.powerState}</p>`
      if (!offline) {
        // was click-only — a keyboard-only user could not launch a
        // stream from here at all. Mirrors renderCatalog()'s game-card
        // pattern below exactly.
        tile.tabIndex = 0
        tile.setAttribute('role', 'button')
        tile.setAttribute('aria-label', `Stream from ${c.deviceName}`)
        const launch = () => startStream('home', c.serverId)
        tile.addEventListener('click', launch)
        tile.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); launch() }
        })
      }
      grid.appendChild(tile)
    }
  } catch (err) {
    grid.innerHTML = `<p class="error small">${err.message || 'Failed to load consoles'}</p>`
  }
}

$('btn-launch-cloud').addEventListener('click', () => {
  const titleId = $('cloud-title-id').value.trim()
  if (titleId) startStream('cloud', titleId)
})

// ---------------------------------------------------------------------
// Game Pass catalog grid — the account's actual entitled titles, fetched
// from our server's /api/catalog (which calls the real xCloud /v2/titles
// endpoint through ApiClient — see server/index.js). Proxied server-side
// because that call needs the account's streaming token, which never
// reaches the browser.
// ---------------------------------------------------------------------

let catalogGames = []

function renderCatalogSkeleton(count = 8) {
  const grid = $('catalog-grid')
  grid.innerHTML = ''
  const frag = document.createDocumentFragment()
  for (let i = 0; i < count; i++) {
    const card = document.createElement('div')
    card.className = 'skeleton-card'
    card.innerHTML = '<div class="skeleton-art"></div><div class="skeleton-title"></div>'
    frag.appendChild(card)
  }
  grid.appendChild(frag)
}

async function loadCatalog() {
  const statusEl = $('catalog-status')
  const grid = $('catalog-grid')

  statusEl.textContent = 'Loading Game Pass catalog…'
  statusEl.classList.remove('hidden')
  renderCatalogSkeleton()

  try {
    const res = await fetch('/api/catalog')
    const data = await res.json()

    if (!res.ok) throw new Error(data.error || 'Failed to load catalog')

    catalogGames = data.games || []

    if (data.stale) {
      statusEl.textContent = 'Showing a cached catalog — the live list is temporarily unavailable.'
      statusEl.classList.remove('hidden')
    } else {
      statusEl.classList.add('hidden')
    }

    renderCatalog(catalogGames)
  } catch (err) {
    catalogGames = []
    statusEl.textContent = err.message || 'Could not load the Game Pass catalog.'
    statusEl.classList.remove('hidden')
    grid.innerHTML = '<p class="error small">Try the Title ID box below instead.</p>'
  }
}

function renderCatalog(games) {
  const grid = $('catalog-grid')
  grid.innerHTML = ''

  if (games.length === 0) {
    grid.innerHTML = '<p class="muted small">No games matched.</p>'
    return
  }

  const frag = document.createDocumentFragment()
  for (const game of games) {
    const card = document.createElement('div')
    card.className = 'game-card'
    card.tabIndex = 0
    card.setAttribute('role', 'button')
    card.setAttribute('aria-label', `Play ${game.title}`)

    const art = document.createElement('div')
    art.className = 'game-art'
    if (game.imageUrl) {
      const img = document.createElement('img')
      img.src = game.imageUrl
      img.alt = ''
      img.loading = 'lazy'
      img.addEventListener('error', () => { art.classList.add('game-art-fallback') }, { once: true })
      art.appendChild(img)
    } else {
      art.classList.add('game-art-fallback')
    }

    const playBadge = document.createElement('div')
    playBadge.className = 'game-play-badge'
    playBadge.innerHTML = '&#9654;'
    art.appendChild(playBadge)

    const title = document.createElement('p')
    title.className = 'game-title'
    title.textContent = game.title

    card.appendChild(art)
    card.appendChild(title)

    const launch = () => startStream('cloud', game.titleId)
    card.addEventListener('click', launch)
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); launch() }
    })

    frag.appendChild(card)
  }
  grid.appendChild(frag)
}

$('catalog-search-input').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase()
  if (!q) { renderCatalog(catalogGames); return }
  renderCatalog(catalogGames.filter((g) => g.title.toLowerCase().includes(q)))
})

// ---------------------------------------------------------------------
// Streaming — copied from the library's own example flow:
// ApiClient.startStream() -> Stream (poll until Provisioned/ReadyToConnect)
// -> Player.createOffer()/setRemoteOffer()/ICE exchange -> attach input.
// ---------------------------------------------------------------------

let currentStream = null
let player = null
let gamepad = null
let keepaliveInterval = null

// Normalizes both our own human-readable progress strings and raw
// RTCPeerConnection connectionState values (from onConnectionStateChange
// below — 'new'/'connecting'/'connected'/'disconnected'/'failed'/'closed',
// the standard WebRTC enum) into the small state set the status badge's
// CSS actually styles: connecting / connected / error.
function setConnectionStatus(text, state) {
  $('connection-status-text').textContent = text
  $('connection-status').dataset.state = state
}

function categorizeWebrtcState(rawState) {
  if (rawState === 'connected') return 'connected'
  if (rawState === 'failed' || rawState === 'disconnected' || rawState === 'closed') return 'error'
  return 'connecting' // 'new', 'connecting', or anything unrecognized
}

async function startStream(type, titleId) {
  showScreen('stream')
  showHud()
  setConnectionStatus('Requesting stream…', 'connecting')

  try {
    currentStream = await apiClient.startStream(type, titleId)

    currentStream.onProvisioned = () => {
      setConnectionStatus('Provisioned — starting player…', 'connecting')
      loadPlayer()

      keepaliveInterval = setInterval(() => {
        currentStream.sendKeepalive().then((response) => {
          if (response.code === 'SessionNotActive' || response.code === 'SessionNotFound') {
            clearInterval(keepaliveInterval)
          }
        }).catch(() => {})
      }, 30 * 1000)
    }

    currentStream.onReadyToConnect = () => {
      setConnectionStatus('Connecting…', 'connecting')
      fetch('/api/msal')
        .then((r) => r.text())
        .then((lpt) => currentStream.sendMSALAuth(lpt))
        .catch((err) => console.error('Failed to send MSAL auth:', err))
    }

    currentStream.onError = () => {
      setConnectionStatus('Stream error.', 'error')
    }

    currentStream.waitForState('Provisioned')
  } catch (err) {
    setConnectionStatus('Failed to start stream: ' + (err.message || err), 'error')
  }
}

// -----------------------------------------------------------------------
// Upstream bug fix: xbox-xcloud-player's InputChannel/InputQueue only
// flushes queued gamepad/mouse/keyboard frames to the wire when a video
// metadata frame is ALSO queued in the same tick (channel/input/queue.ts,
// checkQueueAndSend()) — and metadata frames only get queued from
// render/video.ts's requestVideoFrameCallback, i.e. once per displayed
// video frame, not once per input tick. Gamepad polling runs on its own
// independent ~16ms setTimeout loop (channel/input.ts, gamepadStateLoop),
// so most gamepad frames get pushed into _gamepadQueue and then just sit
// there — silently dropped/overwritten — unless a video frame happens to
// land in the same tick. This is *worse* when the tab is backgrounded or
// unfocused, since requestVideoFrameCallback is throttled there, which
// looks exactly like "input reads correctly but the game never sees it."
//
// Verified directly against the package source (not guessed): grepped
// every call site of queueMetadataFrame/queueGamepadFrames/etc across the
// whole src tree to confirm this is the only path that ever populates
// _metadataQueue, and confirmed InputChannel's _inputQueue field (and
// therefore this method) exists synchronously the instant `new Player()`
// returns — Player's `_channels` and InputChannel's `_inputQueue` are
// both class fields, not lazily created.
//
// The fix: force every checkQueueAndSend() call to actually send instead
// of gating on metadata timing. This is exactly what the library's own
// `forceSend` parameter already exists for — it's just never set to true
// by the internal gamepad/mouse/keyboard loops.
function patchInputQueueBug(playerInstance) {
  const queue = playerInstance?._channels?.input?._inputQueue
  if (!queue || typeof queue.sendQueue !== 'function') {
    console.warn('[input-fix] Could not find InputQueue to patch — falling back to library default behavior (input may be intermittent).')
    return
  }

  queue.checkQueueAndSend = function (forceSend = false) {
    // Still skip a truly empty tick (nothing queued at all) to avoid
    // spamming empty packets — but never withhold a real frame waiting
    // for metadata that may not show up for a while.
    const hasAnything =
      this._metadataQueue.length > 0 ||
      this._gamepadQueue.length > 0 ||
      this._mouseQueue.length > 0 ||
      this._keyboardQueue.length > 0 ||
      this._pointerQueue.length > 0

    if (forceSend || hasAnything) {
      this.sendQueue()
    }
  }
}

// -----------------------------------------------------------------------
// Second upstream bug, found because the queue fix alone wasn't enough:
// ControlChannel.sendAuthorization() — called AUTOMATICALLY and
// internally by the library once the session's message-channel handshake
// completes (channel/message.ts, on 'HandshakeAck') — unconditionally
// does:
//     sendGamepadState(0, true)   // no handler passed
//     sendGamepadState(0, false)  // wipes _gamepadHandlers[0] back to
//                                 // undefined, and (channel now open)
//                                 // actually tells the SERVER gamepad
//                                 // slot 0 was removed
// right after authorization runs. Our own gamepad.attach(player) runs
// earlier, synchronously in attachInput(), well before the connection
// finishes negotiating — so by the time sendAuthorization() fires later,
// it wipes our registration both locally and on the server. After that,
// the game-facing input loop (channel/input.ts gamepadStateLoop) has
// nothing registered to poll — even though our own held Gamepad instance
// still works fine in isolation, which is exactly why diagnostics
// calling gamepad.getGamepadState() directly looked healthy while the
// title itself received nothing (a separate, more tolerant system/
// overlay input path was reacting instead).
//
// Verified from source: sendAuthorization is called from exactly one
// place (message.ts's HandshakeAck handler); ControlChannel's
// wasAdded===false branch really does overwrite _gamepadHandlers[gamepadIndex];
// and Channel.send() silently no-ops (not throws, not queues) when the
// data channel isn't open yet, which is why our early attach's own
// network message got dropped while its later wipe's message actually
// reached the server.
//
// Fix: let the library's own sendAuthorization() run normally (its other
// side effects — the auth handshake itself, keyframe interval setup —
// are legitimate), then immediately re-attach our Gamepad so our
// registration is the one left standing.
function patchAuthorizationWipe(playerInstance) {
  const control = playerInstance?._channels?.control
  if (!control || typeof control.sendAuthorization !== 'function') {
    console.warn('[input-fix] Could not find ControlChannel to patch — gamepad may get silently unregistered after connecting.')
    return
  }

  const original = control.sendAuthorization.bind(control)
  control.sendAuthorization = function (...args) {
    original(...args)
    if (gamepad) {
      gamepad.attach(playerInstance)
    }
  }
}

function loadPlayer() {
  player = new xCloudPlayerLib.Player('streamHolder')
  patchInputQueueBug(player)
  patchAuthorizationWipe(player)

  player.onConnectionStateChange((state) => {
    setConnectionStatus(state, categorizeWebrtcState(state))
    if (state === 'disconnected' || state === 'failed' || state === 'closed') {
      stopStream()
    }
  })

  player.createOffer().then((offer) => {
    currentStream.sendSDPOffer(offer).then((sdpResponse) => {
      player.setRemoteOffer(JSON.parse(sdpResponse.exchangeResponse).sdp)

      const candidates = player.getIceCandidates().map((c) => JSON.stringify({
        candidate: c.candidate,
        sdpMid: c.sdpMid,
        sdpMLineIndex: c.sdpMLineIndex,
        usernameFragment: c.usernameFragment
      }))

      currentStream.sendIceCandidates(candidates).then((iceResponse) => {
        player.setRemoteIceCandidates(JSON.parse(iceResponse.exchangeResponse))
      }).catch((err) => console.error('Failed to send ICE candidates:', err))
    }).catch((err) => console.error('Failed to send offer:', err))
  }).catch((err) => console.error('Failed to create offer:', err))

  attachInput()
}

// The library's Gamepad class handles BOTH a real Gamepad-API controller
// AND a built-in keyboard layout (enable_keyboard: true) — see its
// default keyboard_mapping: arrows move the D-pad, Enter=A, Backspace=B,
// x/y=X/Y, [ ]=bumpers, - ==triggers, v/m=View/Menu, n=Nexus.
//
// IMPORTANT: don't also attach MouseKeyboard here. Every input handler
// (Gamepad, MouseKeyboard, Touch) registers itself on the control channel
// via sendGamepadState(index, true, this) — and that call detaches
// whatever handler already occupies that index before installing the new
// one (xbox-xcloud-player's channel/control.ts). Gamepad and MouseKeyboard
// were both being constructed with index 0, so attaching MouseKeyboard
// right after Gamepad silently called Gamepad.detach() — which strips its
// keydown/keyup/gamepadconnected/gamepaddisconnected listeners — before
// MouseKeyboard finished attaching. The `gamepad` variable in this file
// still pointed at a live-looking object, but it was already inert: no
// keyboard mapping, and no way left to bind a physical controller's index
// when its gamepadconnected event fired. That's the exact bug — the UI
// could still report "controller connected" (that event is native browser
// behaviour, independent of this library) while zero input reached the
// console, and mapped keys like Enter/Backspace/arrows went to
// MouseKeyboard's raw keyboard-frame passthrough instead, which Xbox
// titles generally don't listen for since they expect controller input.
// Gamepad alone already covers both cases this app needs, so MouseKeyboard
// is left unattached.
function attachInput() {
  gamepad = new xCloudPlayerLib.Gamepad(0, { enable_keyboard: true })
  gamepad.attach(player)

  // Reflect whatever the library itself actually bound, not just the raw
  // browser event — gamepadconnected fires on first button press
  // regardless of whether Gamepad's own listener is still attached to
  // catch it, so it's not proof input is flowing on its own.
  updateInputIndicator()
  window.addEventListener('gamepadconnected', updateInputIndicator)
  window.addEventListener('gamepaddisconnected', updateInputIndicator)
}

function updateInputIndicator() {
  const bound = gamepad?.getPhysicalGamepadId() ?? -1
  $('input-indicator').textContent = bound >= 0 ? 'controller connected' : 'keyboard'
}

// ---------------------------------------------------------------------
// Input diagnostics — temporary, on-screen (no dev tools needed on
// mobile). Tap the input indicator badge to toggle. Reads real internals
// off the actual Gamepad/Player instances, not a guess at their shape:
//   - gamepad.getPhysicalGamepadId() / getGamepadState(): public methods
//     on the Gamepad class (input/gamepad.js in xbox-xcloud-player).
//   - player._peerConnection: the RTCPeerConnection Player constructs
//     (player.js: `this._peerConnection = new RTCPeerConnection({})`).
//   - player._channels.input._dataChannel.readyState: the actual
//     RTCDataChannel the input channel sends gamepad frames over
//     (lib/channel.js: `this._dataChannel = ...createDataChannel(...)`).
// These are underscore-prefixed internals, not part of the library's
// public API, so this is read-only inspection for debugging — nothing
// here should ship long-term, but it's the fastest way to see what's
// actually happening without a desktop browser's console.
// ---------------------------------------------------------------------

let diagInterval = null
let sendTracker = null // { count, bytes, lastError, originalSend, dc }

function toggleDiagnostics() {
  const panel = $('input-diag')
  const isHidden = panel.classList.contains('hidden')
  panel.classList.toggle('hidden', !isHidden ? true : false)
  if (isHidden) {
    startDiagnostics()
  } else {
    stopDiagnostics()
  }
}

// Wraps the REAL RTCDataChannel.send() the input channel uses to push
// gamepad frames onto the wire (confirmed against lib/channel.js:
// `send(data) { ... return this._dataChannel.send(data) }` — every
// channel, including input, goes through this one method). getGamepadState()
// proves a frame was BUILT; this proves whether send() was actually CALLED
// and whether the browser's WebRTC stack accepted it or threw. Restores the
// original method in stopSendTracking() so nothing is left patched once the
// panel is closed.
function startSendTracking() {
  stopSendTracking()
  const dc = player?._channels?.input?._dataChannel
  if (!dc) return

  const originalSend = dc.send.bind(dc)
  sendTracker = { count: 0, bytes: 0, lastError: null, originalSend, dc }

  dc.send = (data) => {
    try {
      const result = originalSend(data)
      sendTracker.count += 1
      sendTracker.bytes += (data?.byteLength ?? data?.length ?? 0)
      return result
    } catch (e) {
      sendTracker.lastError = e.message
      throw e
    }
  }
}

function stopSendTracking() {
  if (sendTracker?.dc && sendTracker.originalSend) {
    sendTracker.dc.send = sendTracker.originalSend
  }
  sendTracker = null
}

function startDiagnostics() {
  stopDiagnostics()
  startSendTracking()
  diagInterval = setInterval(renderDiagnostics, 400)
  renderDiagnostics()
}

function stopDiagnostics() {
  if (diagInterval) clearInterval(diagInterval)
  diagInterval = null
  stopSendTracking()
}

function renderDiagnostics() {
  const panel = $('input-diag')
  if (!panel || panel.classList.contains('hidden')) return

  const lines = []
  const ts = new Date().toLocaleTimeString()
  lines.push(`[${ts}] --- input diagnostics ---`)

  // 1. Is a Gamepad instance attached at all?
  if (!gamepad) {
    lines.push('gamepad: NOT ATTACHED (no stream loaded yet?)')
    panel.textContent = lines.join('\n')
    return
  }
  lines.push('gamepad: attached')

  // 2. Has the library actually bound a physical controller index?
  let physicalId
  try {
    physicalId = gamepad.getPhysicalGamepadId()
  } catch (e) {
    physicalId = `ERROR: ${e.message}`
  }
  lines.push(`getPhysicalGamepadId(): ${physicalId}`)

  // 3. Raw browser-level view — what does navigator.getGamepads() see,
  // independent of whether the library's own listener caught it?
  try {
    const pads = navigator.getGamepads ? navigator.getGamepads() : []
    const active = Array.from(pads).filter(Boolean)
    if (active.length === 0) {
      lines.push('navigator.getGamepads(): none reported by browser')
    } else {
      for (const p of active) {
        const pressed = p.buttons.filter((b) => b.pressed || b.value > 0.1).length
        lines.push(`navigator.getGamepads()[${p.index}]: "${p.id}", ${pressed} button(s) currently active`)
      }
    }
  } catch (e) {
    lines.push(`navigator.getGamepads() ERROR: ${e.message}`)
  }

  // 4. Does the library's own state getter produce a frame right now?
  // undefined here means the server-bound input loop has nothing to
  // send this tick — either no physical pad AND no keyboard override
  // active, or focus/attachment problem.
  try {
    const state = gamepad.getGamepadState()
    if (state === undefined) {
      lines.push('getGamepadState(): undefined (no frame to send this tick)')
    } else {
      const pressedButtons = Object.entries(state)
        .filter(([k, v]) => k !== 'GamepadIndex' && typeof v === 'number' && v !== 0)
        .map(([k, v]) => `${k}=${v}`)
      lines.push(`getGamepadState(): frame produced${pressedButtons.length ? ' — ' + pressedButtons.join(', ') : ' (all zero)'}`)
    }
  } catch (e) {
    lines.push(`getGamepadState() ERROR: ${e.message}`)
  }

  // 5. Is the underlying WebRTC connection actually healthy? A frame can
  // be produced correctly and still never reach Xbox's servers if this
  // is anything other than "connected".
  try {
    const pc = player?._peerConnection
    if (!pc) {
      lines.push('player._peerConnection: not found')
    } else {
      lines.push(`RTCPeerConnection.connectionState: ${pc.connectionState}`)
      lines.push(`RTCPeerConnection.iceConnectionState: ${pc.iceConnectionState}`)
    }
  } catch (e) {
    lines.push(`peerConnection check ERROR: ${e.message}`)
  }

  // 6. Is the specific data channel gamepad frames travel over actually
  // open? "connecting" or "closed" here would explain frames being
  // produced correctly but never arriving server-side.
  try {
    const inputChannel = player?._channels?.input
    const dc = inputChannel?._dataChannel
    if (!dc) {
      lines.push('input channel dataChannel: not found')
    } else {
      lines.push(`input dataChannel.readyState: ${dc.readyState}`)
    }
  } catch (e) {
    lines.push(`dataChannel check ERROR: ${e.message}`)
  }

  // 7. Is data ACTUALLY leaving the browser? Steps 4-6 can all look
  // healthy (frame built, channel open) while still never truly calling
  // send() if something upstream silently skips it. This counts real
  // calls to the actual RTCDataChannel.send() the input channel uses.
  // If the dataChannel wasn't ready yet when diagnostics started (e.g.
  // panel opened mid-connect), retry attaching here so it still ends up
  // tracked once the channel exists.
  if (!sendTracker) startSendTracking()
  if (sendTracker) {
    lines.push(`dataChannel.send() calls seen: ${sendTracker.count} (${sendTracker.bytes} bytes total)`)
    if (sendTracker.lastError) {
      lines.push(`dataChannel.send() last error: ${sendTracker.lastError}`)
    }
  } else {
    lines.push('dataChannel.send() tracking: not attached yet (channel not ready)')
  }

  panel.textContent = lines.join('\n')
}

$('input-indicator').addEventListener('click', toggleDiagnostics)

function stopStream() {
  clearInterval(keepaliveInterval)
  clearTimeout(hudHideTimer)
  stopDiagnostics()
  gamepad?.detach()
  gamepad = null
  window.removeEventListener('gamepadconnected', updateInputIndicator)
  window.removeEventListener('gamepaddisconnected', updateInputIndicator)

  if (isFullscreen()) {
    exitFullscreen()
  }

  if (player) {
    player.destroy()
    player = null
  }

  if (currentStream) {
    currentStream.stop().catch(() => {})
    currentStream = null
  }

  showScreen('library')
  loadConsoles()
}

$('btn-back').addEventListener('click', stopStream)

// ---------------------------------------------------------------------
// Fullscreen — targets #screen-stream (not just the video) so the HUD
// and the input diagnostics overlay stay usable while fullscreen too.
// ---------------------------------------------------------------------

const streamScreen = screens.stream

function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement)
}

async function enterFullscreen() {
  const el = streamScreen
  const request = el.requestFullscreen || el.webkitRequestFullscreen
  if (!request) return
  try {
    await request.call(el)
  } catch (err) {
    console.warn('Fullscreen request failed:', err)
  }
}

async function exitFullscreen() {
  const exit = document.exitFullscreen || document.webkitExitFullscreen
  if (!exit) return
  try {
    await exit.call(document)
  } catch (err) {
    console.warn('Fullscreen exit failed:', err)
  }
}

$('btn-fullscreen').addEventListener('click', () => {
  if (isFullscreen()) {
    exitFullscreen()
  } else {
    enterFullscreen()
  }
})

function updateFullscreenButtonState() {
  $('btn-fullscreen').classList.toggle('is-active', isFullscreen())
  showHud() // always show the HUD briefly right after a fullscreen change
}

document.addEventListener('fullscreenchange', updateFullscreenButtonState)
document.addEventListener('webkitfullscreenchange', updateFullscreenButtonState)

// Auto-hide the HUD while fullscreen and idle, so it doesn't sit on top
// of gameplay. Not fullscreen: HUD just stays visible, no timer needed.
let hudHideTimer = null

function showHud() {
  streamScreen.classList.add('hud-visible')
  clearTimeout(hudHideTimer)
  if (isFullscreen()) {
    hudHideTimer = setTimeout(() => {
      streamScreen.classList.remove('hud-visible')
    }, 2500)
  }
}

for (const evt of ['mousemove', 'touchstart', 'keydown']) {
  streamScreen.addEventListener(evt, showHud)
}

checkAppSession()
