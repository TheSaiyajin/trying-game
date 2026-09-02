Project
Browser multiplayer territory/faction game.
Node.js + Express + PostgreSQL backend.
Vanilla HTML/CSS/JS frontend.
Backend is authoritative for all game state and calculations.
Work efficiently
Make the smallest change that fully solves the request.
Inspect/search only files and functions relevant to the task.
Do not scan the whole repository unless necessary.
Do not read package-lock.json unless dependencies are involved.
Reuse existing functions, APIs, database patterns and UI styles.
Do not refactor, rename, reorganize or add dependencies unless required.
Do not implement features that were not requested.
If the request is clear, implement it directly instead of producing a long plan.
Keep explanations short after completing the work.
Every player-visible feature, balance change, or fix must add a simple entry to changelog.json. Internal tests, deployments, and refactoring do not require entries.
Safety and correctness
Never trust client-provided user ID, faction, role, resources, troops, ownership or combat results.
Resolve player identity/permissions server-side from authentication and database state.
Keep game-critical calculations server-side.
Validate inputs and handle API/database errors without crashing the server.
Never expose secrets, JWT secrets, database credentials or admin tokens to frontend code.
Preserve existing API behavior unless the requested feature requires changing it.
Database
Before changing schema constraints, consider existing player/data rows.
Backfill existing rows when adding required fields.
Keep database initialization/seed logic compatible with schema changes.
Avoid destructive database changes unless explicitly requested.
Before finishing
Check modified JS for syntax/errors.
Run npm test.
Run npm run build.
Fix failures caused by the change.
Do not modify deployment/workflows/VPS configuration unless requested.
Stop once the requested feature works.
