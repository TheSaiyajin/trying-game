# Admin

Sai’s operator panel. Nav item hidden for everyone else.

## Intent

Admin is a **testing and recovery** tool for the live shared world, not a second game. It must use the **same** rollover/reset functions as production so “force finish” cannot diverge from the clock. Every write is audited. The username `Sai` is the only admin identity on purpose — a small game, one operator. Revoking admin (role change in DB) must take effect on the **next** request.

## Player sees (Sai only)

**Season** — live number, end time, scores, member counts. Force-Finish (browser `confirm`).

**World** — Reset World (map + everyone to starting resources/buildings, accounts kept). Reset All Resources. Force Resource Tick.

**Players** — id, username, faction, role, soldiers, resources. Editors: role (`member`/`leader`; Sai locked `admin`), faction, soldiers, resources, per-player reset. Confirms on destructive actions.

**Territories** — owner + defense editors, set capital. Capital owner cannot be overwritten via the generic editor.

## Rules

- Gate: `username === auth.adminUsername` **and** DB `role === admin`, every request (`isAuthorizedAdminPlayer`).
- Bootstrap: `ADMIN_BOOTSTRAP_TOKEN` in env, CLI only, never HTTP.
- Force-finish requires `{ confirm: true }` and calls the same finalize as the timer.
- Faction change recalls garrisons that would become illegal.
- Defense edits cannot go below stationed troop sum.
- `leader` is stored (and `faction_leaders` written) but **gameplay never reads it**. Keep as-is until the user decides to drop it.

## Edges

- Client `isAdminUser` is UX only. A forged UI still dies on `requireAdmin`.
- Reset World does not delete accounts or chat history unless that SQL path says so — check `admin-resets.js` before changing.
- Do not add a web “make me admin” button.

## Tune

`auth.adminUsername`, `economy.starting*` in `config/balance.json`. Token = env.

## API

[`05-API-CONTRACT.md`](../05-API-CONTRACT.md) — Admin table.

## Code

BE: `backend/admin-*.js`  
FE: `renderAdminPanel`, `admin*` handlers (same `confirm()` prompts)
