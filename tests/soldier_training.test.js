const test = require('node:test');
const assert = require('node:assert/strict');
const { TrainingError, performSoldierTraining } = require('../backend/soldier-training');
const { getTrainingCost } = require('../backend/game-logic');

function createTrainingState(resources = {}) {
  return {
    player: {
      id: 1,
      faction: 'blue',
      resource_food: resources.food ?? 500,
      resource_iron: resources.iron ?? 250,
      resource_manpower: resources.manpower ?? 200,
      soldiers: resources.soldiers ?? 0,
    },
    lockTail: Promise.resolve(),
  };
}

function createTrainingClient(state) {
  let releaseLock = null;
  return {
    async query(sql, params = []) {
      const text = sql.trim();
      if (text === 'BEGIN') return { rows: [] };
      if (text === 'COMMIT' || text === 'ROLLBACK') {
        releaseLock?.();
        releaseLock = null;
        return { rows: [] };
      }
      if (text === 'SELECT * FROM players WHERE id = $1 FOR UPDATE') {
        const previousLock = state.lockTail;
        state.lockTail = new Promise((resolve) => { releaseLock = resolve; });
        await previousLock;
        return { rows: params[0] === state.player.id ? [{ ...state.player }] : [] };
      }
      if (text.startsWith('SELECT owner_faction') || text.startsWith('SELECT t.owner_faction')) return { rows: [] };
      if (text.startsWith('UPDATE players')) {
        const [food, iron, manpower, soldiers] = params;
        state.player.resource_food -= food;
        state.player.resource_iron -= iron;
        state.player.resource_manpower -= manpower;
        state.player.soldiers += soldiers;
        return { rows: [] };
      }
      throw new Error(`Unexpected training query: ${text}`);
    },
  };
}

test('insufficient training resources roll back without creating soldiers', async () => {
  const state = createTrainingState({ food: 500, iron: 250, manpower: 199, soldiers: 3 });

  await assert.rejects(
    performSoldierTraining(createTrainingClient(state), { playerId: 1, count: 10 }),
    (error) => error instanceof TrainingError && error.status === 400
  );
  assert.deepEqual(state.player, {
    id: 1,
    faction: 'blue',
    resource_food: 500,
    resource_iron: 250,
    resource_manpower: 199,
    soldiers: 3,
  });
});

test('simultaneous training requests cannot overspend locked resources', async () => {
  const state = createTrainingState();
  const results = await Promise.allSettled([
    performSoldierTraining(createTrainingClient(state), { playerId: 1, count: 10 }),
    performSoldierTraining(createTrainingClient(state), { playerId: 1, count: 10 }),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(state.player.soldiers, 10);
  assert.deepEqual({
    food: state.player.resource_food,
    iron: state.player.resource_iron,
    manpower: state.player.resource_manpower,
  }, { food: 0, iron: 0, manpower: 0 });
});

test('training discounts round every resource cost up', () => {
  assert.deepEqual(getTrainingCost(1, 0.97), {
    food: 49,
    iron: 25,
    manpower: 20,
  });
});
