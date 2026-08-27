DELETE FROM attack_contributions;
DELETE FROM attack_targets;
DELETE FROM territory_neighbors;
DELETE FROM territories;
DELETE FROM buildings;
DELETE FROM players;

-- Map is a 3-fold rotationally symmetric ring layout: capital -> home (3) -> frontier (3)
-- -> border with each neighboring faction (3) -> shared core (3). Every faction gets an
-- identical set of bonus types along its own path (food, wood, manpower, iron, training,
-- resource) so no faction starts with an economic advantage.
INSERT INTO territories (id, name, owner_faction, defense_troops, bonus_type, bonus_value, is_fortress, is_capital, resource_bonus, storage_bonus) VALUES
  ('b1', 'Blue Capital', 'blue', 35, 'resource', 0.1, FALSE, TRUE, 0.1, 0.1),
  ('r1', 'Red Capital', 'red', 35, 'resource', 0.1, FALSE, TRUE, 0.1, 0.1),
  ('g1', 'Green Capital', 'green', 35, 'resource', 0.1, FALSE, TRUE, 0.1, 0.1),

  -- Home ring: adjacent to each capital, one of each core economic resource.
  ('n1', 'Blue Farmstead', 'neutral', 18, 'food', 0.10, FALSE, FALSE, 0.10, 0.00),
  ('n2', 'Blue Timberland', 'neutral', 18, 'wood', 0.10, FALSE, FALSE, 0.10, 0.00),
  ('n3', 'Blue Muster Camp', 'neutral', 18, 'manpower', 0.10, FALSE, FALSE, 0.10, 0.00),
  ('n4', 'Red Farmstead', 'neutral', 18, 'food', 0.10, FALSE, FALSE, 0.10, 0.00),
  ('n5', 'Red Timberland', 'neutral', 18, 'wood', 0.10, FALSE, FALSE, 0.10, 0.00),
  ('n6', 'Red Muster Camp', 'neutral', 18, 'manpower', 0.10, FALSE, FALSE, 0.10, 0.00),
  ('n7', 'Green Farmstead', 'neutral', 18, 'food', 0.10, FALSE, FALSE, 0.10, 0.00),
  ('n8', 'Green Timberland', 'neutral', 18, 'wood', 0.10, FALSE, FALSE, 0.10, 0.00),
  ('n9', 'Green Muster Camp', 'neutral', 18, 'manpower', 0.10, FALSE, FALSE, 0.10, 0.00),

  -- Frontier ring: one step further out, completes the bonus set with iron/training/resource.
  ('n10', 'Blue Ore Ridge', 'neutral', 21, 'iron', 0.10, FALSE, FALSE, 0.10, 0.00),
  ('n11', 'Blue Drill Yard', 'neutral', 21, 'training', 0.05, FALSE, FALSE, 0.05, 0.00),
  ('n12', 'Blue Trade Post', 'neutral', 21, 'resource', 0.10, FALSE, FALSE, 0.10, 0.10),
  ('n13', 'Red Ore Ridge', 'neutral', 21, 'iron', 0.10, FALSE, FALSE, 0.10, 0.00),
  ('n14', 'Red Drill Yard', 'neutral', 21, 'training', 0.05, FALSE, FALSE, 0.05, 0.00),
  ('n15', 'Red Trade Post', 'neutral', 21, 'resource', 0.10, FALSE, FALSE, 0.10, 0.10),
  ('n16', 'Green Ore Ridge', 'neutral', 21, 'iron', 0.10, FALSE, FALSE, 0.10, 0.00),
  ('n17', 'Green Drill Yard', 'neutral', 21, 'training', 0.05, FALSE, FALSE, 0.05, 0.00),
  ('n18', 'Green Trade Post', 'neutral', 21, 'resource', 0.10, FALSE, FALSE, 0.10, 0.10),

  -- Border rings: contested ground between each pair of neighboring factions.
  ('n19', 'Stonewatch Keep', 'neutral', 24, 'fortress', 0.20, TRUE, FALSE, 0.00, 0.10),
  ('n20', 'Border Vault', 'neutral', 24, 'storage', 0.20, FALSE, FALSE, 0.00, 0.20),
  ('n21', 'Contested Market', 'neutral', 24, 'resource', 0.10, FALSE, FALSE, 0.10, 0.10),
  ('n22', 'Ember Keep', 'neutral', 24, 'fortress', 0.20, TRUE, FALSE, 0.00, 0.10),
  ('n23', 'Ember Vault', 'neutral', 24, 'storage', 0.20, FALSE, FALSE, 0.00, 0.20),
  ('n24', 'Ember Market', 'neutral', 24, 'resource', 0.10, FALSE, FALSE, 0.10, 0.10),
  ('n25', 'Verdant Keep', 'neutral', 24, 'fortress', 0.20, TRUE, FALSE, 0.00, 0.10),
  ('n26', 'Verdant Vault', 'neutral', 24, 'storage', 0.20, FALSE, FALSE, 0.00, 0.20),
  ('n27', 'Verdant Market', 'neutral', 24, 'resource', 0.10, FALSE, FALSE, 0.10, 0.10),

  -- Core: the single most valuable cluster, equidistant from all three factions.
  ('n28', 'Crown Bastion', 'neutral', 28, 'fortress', 0.25, TRUE, FALSE, 0.00, 0.15),
  ('n29', 'Crown Treasury', 'neutral', 28, 'storage', 0.25, FALSE, FALSE, 0.00, 0.25),
  ('n30', 'Crown Spire', 'neutral', 28, 'resource', 0.15, FALSE, FALSE, 0.15, 0.15);

INSERT INTO territory_neighbors (territory_id, neighbor_id) VALUES
  -- Capital <-> home ring
  ('b1', 'n1'), ('b1', 'n2'), ('b1', 'n3'),
  ('r1', 'n4'), ('r1', 'n5'), ('r1', 'n6'),
  ('g1', 'n7'), ('g1', 'n8'), ('g1', 'n9'),
  ('n1', 'b1'), ('n2', 'b1'), ('n3', 'b1'),
  ('n4', 'r1'), ('n5', 'r1'), ('n6', 'r1'),
  ('n7', 'g1'), ('n8', 'g1'), ('n9', 'g1'),

  -- Home ring internal triangle (per faction)
  ('n1', 'n2'), ('n2', 'n1'), ('n2', 'n3'), ('n3', 'n2'), ('n3', 'n1'), ('n1', 'n3'),
  ('n4', 'n5'), ('n5', 'n4'), ('n5', 'n6'), ('n6', 'n5'), ('n6', 'n4'), ('n4', 'n6'),
  ('n7', 'n8'), ('n8', 'n7'), ('n8', 'n9'), ('n9', 'n8'), ('n9', 'n7'), ('n7', 'n9'),

  -- Home <-> frontier ring (same slot per faction)
  ('n1', 'n10'), ('n10', 'n1'),
  ('n2', 'n11'), ('n11', 'n2'),
  ('n3', 'n12'), ('n12', 'n3'),
  ('n4', 'n13'), ('n13', 'n4'),
  ('n5', 'n14'), ('n14', 'n5'),
  ('n6', 'n15'), ('n15', 'n6'),
  ('n7', 'n16'), ('n16', 'n7'),
  ('n8', 'n17'), ('n17', 'n8'),
  ('n9', 'n18'), ('n18', 'n9'),

  -- Frontier ring internal triangle (per faction)
  ('n10', 'n11'), ('n11', 'n10'), ('n11', 'n12'), ('n12', 'n11'), ('n12', 'n10'), ('n10', 'n12'),
  ('n13', 'n14'), ('n14', 'n13'), ('n14', 'n15'), ('n15', 'n14'), ('n15', 'n13'), ('n13', 'n15'),
  ('n16', 'n17'), ('n17', 'n16'), ('n17', 'n18'), ('n18', 'n17'), ('n18', 'n16'), ('n16', 'n18'),

  -- Frontier <-> border rings (each faction touches its two neighboring border zones)
  ('n12', 'n19'), ('n19', 'n12'),
  ('n10', 'n27'), ('n27', 'n10'),
  ('n13', 'n21'), ('n21', 'n13'),
  ('n15', 'n22'), ('n22', 'n15'),
  ('n16', 'n24'), ('n24', 'n16'),
  ('n18', 'n25'), ('n25', 'n18'),

  -- Border ring internal triangles (per faction pair)
  ('n19', 'n20'), ('n20', 'n19'), ('n20', 'n21'), ('n21', 'n20'), ('n21', 'n19'), ('n19', 'n21'),
  ('n22', 'n23'), ('n23', 'n22'), ('n23', 'n24'), ('n24', 'n23'), ('n24', 'n22'), ('n22', 'n24'),
  ('n25', 'n26'), ('n26', 'n25'), ('n26', 'n27'), ('n27', 'n26'), ('n27', 'n25'), ('n25', 'n27'),

  -- Border <-> core
  ('n20', 'n28'), ('n28', 'n20'),
  ('n23', 'n29'), ('n29', 'n23'),
  ('n26', 'n30'), ('n30', 'n26'),

  -- Core internal triangle
  ('n28', 'n29'), ('n29', 'n28'), ('n29', 'n30'), ('n30', 'n29'), ('n30', 'n28'), ('n28', 'n30');

