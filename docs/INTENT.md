# Locked intent

This is the product. Do not “improve” it unless the user explicitly asks.

A later agent should read this file **before** changing code. Numbers live in [`config/balance.json`](../config/balance.json). Behavior lives in [`features/`](features/README.md). HTTP shapes live in [`05-API-CONTRACT.md`](05-API-CONTRACT.md).

## What SaiWars is

A **shared-world**, browser, three-faction territory war (blue / red / green). Everyone plays on the same map. Private cities feed a public war. Seasons are campaigns; the map and scores reset between them.

It is a **port-in-progress** (vanilla + Express → Next.js + NestJS). Until the user says otherwise: **port, do not redesign**.

## Player-facing rules that must not drift

1. **Players never pick a faction.** Join assigns the smallest faction. Registration must ignore any faction field.
2. **The server is the only authority.** The client renders snapshots and submits intents (train, attack, chat). It must not invent resources, combat results, ownership, or role.
3. **Combat is deterministic (no RNG).** Neutral hexes: more attackers than defenders wins instantly. Faction hexes: hidden rally, then live rounds with a fixed 10% casualty rate and capped attack/defense land bonuses. Capitals cannot be taken. “Strategic combat” beyond that is still Later.
4. **Capitals cannot be taken.** Adjacent-to-own-faction only.
5. **Admin is Sai only**, after CLI bootstrap — never at register. Support money **never** buys in-game advantage (Info modal promise).
6. **Only HTTP 401 logs the player out.** 429 / 5xx / network = retry. Mid-rollover must not bounce people to login.
7. **Chat is faction + season scoped.** After a faction or season change, old messages must not flash on screen.

## How to change things

| Kind of change | Where |
|---|---|
| A number (cost, duration, cap, rate) | `config/balance.json` only |
| Map graph / hex layout / per-hex bonus type | topology modules, then regenerate seed |
| Player-visible rule or UX contract | update the matching `docs/features/*.md` **and** the code |
| HTTP shape | `docs/05-API-CONTRACT.md` first |
| “Wouldn’t this be nicer?” during the FE/BE split | **no** — record it here under Later, don’t ship it |

## Later (explicitly not now)

Strategic combat, comeback systems, map events, season rewards beyond `season_wins`, paid cosmetics, choosing a faction, Godot client, scoped realtime channels. The Info modal may mention some of these. Do not build them during the split.
