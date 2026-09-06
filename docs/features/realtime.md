# Realtime

How every screen stays in sync. Not a screen of its own.

## Intent

Keep the model stupid: **one ping, then the client asks for the truth**. Do not push partial worlds over the socket — that is how the vanilla client and the future Godot client stay compatible. Global broadcast is fine at current scale. Polling is the safety net for missed pings and for chat while that tab is open.

## Player sees

Nothing labeled “realtime.” They see the city/map/chat update after someone else acts, usually within a couple of seconds. On failure: reconnect toast, not logout (unless 401).

## Rules

- Socket.IO handshake `auth.token` = JWT. Bad/missing → connection error string, not a guest session.
- Server event: `state:changed` `{ revision }` after mutating 2xx, a tick that changed anyone, or a visible season change.
- Client: debounce `realtime.refreshDebounceMs`, one in-flight snapshot, queue one more if a ping arrives during fetch.
- Polls: snapshot `realtime.snapshotPollMs`; activity `realtime.activityPollMs` while Activity is open; chat `realtime.chatPollMs` while Chat is open; scoreboard countdown 1 s locally.
- Background refresh: if the season gate now applies, **show the gate**. If the territory panel is open, re-select the same hex and **keep troop inputs**.
- Chat poll uses near-bottom rule ([Chat](chat.md)).

## Edges

- Vanilla loads `/socket.io/socket.io.js` from the API host — the split must ship `socket.io-client` on the web app instead.
- Amplification: every client refetches the full snapshot. Do not “fix” with per-player events during the port ([INTENT](../INTENT.md) Later).
- HTTP rate limit `limits.globalRate` (env override allowed). 429 must not clear the JWT.

## Tune

`config/balance.json` → `realtime.*`, `limits.globalRate`

## API

[`05-API-CONTRACT.md`](../05-API-CONTRACT.md) — Realtime channel.

## Code

BE: `backend/realtime.js`, mutation middleware in `server.js`  
FE: `connectRealtime`, `scheduleRealtimeRefresh`, `refreshGameStateInBackground`
