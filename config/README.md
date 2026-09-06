# Game balance

[`balance.json`](balance.json) is the only file that should change when tuning numbers.

Backend modules load it through [`balance.js`](balance.js). Feature pages in [`docs/features/`](../docs/features/README.md) name the keys they use.

Do **not** put secrets here. JWT, database, and bootstrap tokens stay in `.env`.

Map geometry, adjacency, and per-hex bonus layout stay in `world-topology.js` / `crownlands-topology.js` — those are map data, not global knobs.
