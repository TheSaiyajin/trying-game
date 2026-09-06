# Auth

Accounts and the JWT the client stores. Screen: login / register.

## Intent

Anyone can make an account. Nobody is special at signup — not even the username `Sai`. Faction is a **season assignment**, not a profile choice, so register/login must never accept it. Sessions are boring on purpose: 24 h JWT, server re-checks role every request.

## Player sees

- Toggle Login / Register.
- Username + password. Register also shows confirm-password.
- Copy that they will be auto-assigned to the smallest faction when the season starts (not a picker).
- Errors inline (`auth-message`) plus toasts.

## Rules

- Username: `auth.usernamePattern` (3–32, letters/numbers/`_`/`-`).
- Password ≥ `auth.passwordMinLength`. Confirm must match on register.
- Register → always role `member`, faction `NULL`.
- Login failure for unknown user and bad password is the same `401 Invalid credentials.`
- Token in `localStorage` `trying_game_token`. Sent as `Authorization: Bearer`.
- **Only 401** deletes the token. That is a client contract the mock must honor.

## Edges

- `Sai` registering is a normal member until `node backend/db.js --bootstrap-admin <token>`.
- JWT payload may contain `faction`/`role`; **authorization must ignore those fields** and read the DB.
- Production refuses to start if `JWT_SECRET` is missing or the documented dev fallback.

## Tune

[`config/balance.json`](../../config/balance.json) → `auth.*`

## API

[`05-API-CONTRACT.md`](../05-API-CONTRACT.md) — Auth.

## Code

BE: `backend/auth.js`, `backend/admin-policy.js`, `POST /api/register`, `POST /api/login`, `GET /api/me`  
FE: `submitAuth`, `ensureSession`, `logoutPlayer`
