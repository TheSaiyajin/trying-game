# Map

Shared hex war. Screen: Map. Fighting is [Combat](combat.md). Scoring is [Seasons](seasons.md).

## Intent

The map is the product. Both factions of a pair must have the **same** shape, bonuses, and distances (120° rotation). Agents must not “tweak one side.” Layout comes from topology modules — the same data seeds the database — so the picture cannot lie about adjacency.

Crownlands `attack` / `defense` bonus **labels** are flavor. `getFactionTerritoryBonuses` does not consume them. Do not invent combat math for them during the port.

## Player sees

- Scoreboard (season, countdown, territories · pts · players).
- Legend: Blue / Red / Green, with `(You)` on the player’s color, plus Target.
- SVG hexes: fill by owner, troop count, bonus icon, capital mark. Selected hex highlighted.
- Zoom: desktop wheel-to-cursor; desktop drag-pan; mobile pinch/pan; on narrow screens also − / + / Reset. After a drag, clicks are suppressed ~400 ms so pan does not select a hex.
- Territory panel: name, owner, defenders, in city, stationed (this player), battle rule (“More troops wins”), bonus text, neighbors. Close ×.

## Rules

- Maps: `three-frontiers` (33) and `crownlands-64` (64). Season stores `map_key`; rollover uses `getNextMapKey`.
- Owner is `blue|red|green|neutral`. `defense` = base NPC + all stationed troops.
- Attackable if: not capital, not own faction, adjacent to **some** hex the attacker’s faction owns (not merely adjacent to the selected hex’s neighbor list without a faction link).
- Capitals: protected (`territory-protection.js`). Score 0.
- Score values: capital 0, normal 1, Three Frontiers cores 2, Crownlands crown 3.

## Edges

- `buildTerritoryLayout` drops unknown snapshot ids onto a fallback grid so a mismatched seed still paints.
- Full SVG rebuild on every refresh (vanilla). Camera state (`mapView`) is UI-only and must survive re-render.
- Zoom buttons no-op on desktop (`max-width: 520px` guard); wheel is the desktop path.

## Tune

Global: `config/balance.json` `scoring.*`  
Geometry: `world-topology.js`, `crownlands-topology.js`, `map-registry.js`

## API

`GameSnapshot.world.territories`, `GET /world/map/:mapKey` (split; layout for the new FE)

## Code

FE: `renderMap`, `buildTerritoryLayout`, `initializeMobileMap`, `selectTerritory`, `renderMapLegend`  
BE: `backend/topology-sql.js`, `getTerritoriesSnapshot`
