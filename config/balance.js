'use strict';

function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    if (Array.isArray(value)) {
      for (const item of value) freezeDeep(item);
    } else {
      for (const nested of Object.values(value)) freezeDeep(nested);
    }
    Object.freeze(value);
  }
  return value;
}

module.exports = freezeDeep(require('./balance.json'));
