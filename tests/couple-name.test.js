// tests/couple-name.test.js
// Issue #354 AC15: the seeded "Snap the happy couple" task spells the bride's
// name "Lilly" (two Ls), not the retired one-L "Lily" spelling, on a fresh
// database seeded by the real scripts/seed.js.
'use strict';

const { loadApp } = require('./helpers/testApp');

describe('#354 AC15: seeded couple-name task spells the bride "Lilly"', () => {
  let db;

  beforeAll(() => {
    ({ db } = loadApp());
    // Seed the real sample tasks via the actual seed script (it binds to the
    // temp DATA_DIR loadApp just created), same pattern as
    // tests/badge-catalog.test.js's beforeAll.
    require('../scripts/seed.js');
  });

  it('the "Snap the happy couple" task description contains "Axel and Lilly", not one-L "Lily "', () => {
    const row = db
      .prepare('SELECT description FROM tasks WHERE title = ?')
      .get('Snap the happy couple');

    expect(row).toBeTruthy();
    expect(row.description).toContain('Axel and Lilly');
    expect(row.description).not.toContain('Lily ');
  });
});
