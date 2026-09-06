# Chat

Private faction channel for the **current** season. Screen: Chat.

## Intent

This is a war room, not a global Discord. The other factions must never see it. After you are reassigned next season, yesterday’s room is gone — including any messages still sitting in the client cache. Rate limits exist so one person cannot flood the shared socket-refresh.

## Player sees

- Member list + count (usernames only, own faction).
- Messages oldest → newest: `username · local timestamp`, then body (text, not HTML).
- Emoji row: ⚔️ 🛡️ 🏰 ✅ ❌ 🔥 inserted at the caret.
- Textarea max `chat.maxLength`. Enter sends, Shift+Enter newline.
- Hint: “Only your current faction can read these messages.”

## Rules

- Rows keyed by `(season_id, faction)`. List last `chat.listLimit`.
- Empty/whitespace rejected. Length counted in Unicode code points (`Array.from`).
- Send: `chat.sendPerMinute` per user per `chat.sendWindowMs` → 429.
- If the player is scrolled near the bottom (≤24 px), a poll may jump to newest. If they scrolled up, **do not** steal the scroll.
- Opening the Chat tab always scrolls to newest once.
- `setGameStateFromSnapshot` **clears** `chatMessages` when faction changes.

## Edges

- Polling runs only while the Chat screen is `active` (`realtime.chatPollMs`).
- Server trims the message; client should still send the raw textarea value.
- No attachments, no DMs, no cross-faction mail.

## Tune

`config/balance.json` → `chat.*`, `realtime.chatPollMs`

## API

`GET|POST /game/faction-chat`, `GET /game/faction-members`

## Code

BE: `backend/faction-chat.js`  
FE: `renderFactionChat`, `sendFactionChatMessage`, `insertChatEmoji`, `isFactionChatNearBottom`
