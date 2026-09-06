# Shell

Everything around the five screens: boot, chrome, persistence, feedback.

## Intent

The game should feel like one continuous session. A blip (rate limit, rollover, dropped socket) must **reconnect**, not dump the player on login. Last screen is remembered per account so refresh does not yank them back to City. Info is honest: support never buys power.

## Player sees

- Boot spinner until session + snapshot resolve.
- **Auth** or **season gate** or **game shell**.
- Top bar: title, `username · {Faction} Faction`, Info, Logout.
- Info modal: what the game is, future plans, support note, Discord `thesaiyajin`. Esc / backdrop / × close.
- Resource bar: food / wood / iron / manpower as `current / cap` (compact `k` at ≥10k).
- Bottom nav: City, Map, Activity, Chat; Admin only if Sai+admin.
- Faction color on the shell (`data-faction`).
- Toasts for actions and reconnect (`⚠️ Reconnecting…`).

## Rules

- Screens: `city` `map` `activity` `chat` `admin`. Saved in `localStorage` key `trying_game_screen_<playerId>`.
- Restore ignores `admin` unless `isAdminUser` (username `Sai` and role `admin`). Default screen: City.
- `showScreen` re-renders that screen. Switching to chat forces scroll-to-newest once.
- Temporary session errors (`error.isTemporary`: 429/5xx/network) retry `loadGame` after `realtime.bootRetryMs`.
- Brief gap with no faction after join/rollover: retry `loadGame` after 750 ms — **never** a “pick faction” UI.
- Pull-to-refresh fallback exists for mobile; do not treat it as a second save system. There is no client save of game state.

## Edges

- Identity line is `—` until faction exists.
- Resource-bar fallback cap `10000` if the snapshot omits `storageCaps` — display only; server caps are authoritative.
- `saveGame` / `resetGame` / `autoSave` in `script.js` are **dead**. Do not port.

## Tune

`config/balance.json` → `realtime.bootRetryMs`, `economy.baseStorageCap` (display fallback)

## Code

FE: `loadGame`, `showScreen`, `restoreSavedScreen`, `updateResourceBar`, `updatePlayerIdentity`, `updateFactionTheme`, `showToast`, `openInfoModal`  
BE: none (chrome is client-only; data comes from `GET /game/state`)
