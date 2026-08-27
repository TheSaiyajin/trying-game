# trying-game

Minimal multiplayer test project for a shared-world faction game.

## Requirements
- Node.js 18+
- PostgreSQL 14+
- A database named `trying_game`

## Setup
1. Create the PostgreSQL database:
   ```sql
   CREATE DATABASE trying_game;
   ```
2. Copy `.env.example` to `.env` and set values for your local PostgreSQL connection and JWT secret.
3. Install dependencies:
   ```bash
   npm install
   ```
4. Initialize the schema and seed data:
   ```bash
   npm run db:init
   ```
5. Start the server:
   ```bash
   npm start
   ```

## Notes
- The backend owns all game-critical calculations and storage.
- The frontend only renders server state and submits actions.
- The world seed creates 33 territories: 1 blue, 1 red, 1 green, plus neutral territories with diverse bonuses.
- Multiple clients can log in to the same database and see the same shared world state.

## Admin bootstrap
Registering with the username `Sai` never grants admin automatically — it always creates a
normal member account. To promote the `Sai` account to admin:

1. Register the `Sai` account normally through the app.
2. Set `ADMIN_BOOTSTRAP_TOKEN` in the server's environment (a long random secret, server-side
   only; it is never sent to the browser or referenced in frontend JavaScript).
3. On the server, run:
   ```bash
   node backend/db.js --bootstrap-admin <ADMIN_BOOTSTRAP_TOKEN>
   ```
   This is a one-off CLI command, not an HTTP endpoint, so the token never travels over the
   network. Every admin-only request still re-checks the player's current role in PostgreSQL,
   so revoking admin later (e.g. via another player's role update) takes effect immediately.

## Production startup requirements
In production (`NODE_ENV=production`), the server refuses to start unless `JWT_SECRET` is set
to something other than the development fallback (`dev-secret-change-me`). Development mode may
still use the documented fallback for convenience.