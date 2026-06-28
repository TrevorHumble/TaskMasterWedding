// tests/export-injection.test.js
'use strict';

const { loadApp } = require('./helpers/testApp');
const ExcelJS = require('exceljs');

// Declared here; assigned inside beforeAll after loadApp() so that config/db
// read the env at first require — the export module must be required after
// loadApp() has set DATA_DIR/DB_PATH, otherwise it binds to the real dev DB.
let buildSummaryBuffer;
let neutralizeCell;

beforeAll(() => {
  const { db } = loadApp();
  // config/db read the env at first require, so the export module must be
  // required after loadApp() sets DATA_DIR/DB_PATH.
  ({ buildSummaryBuffer, neutralizeCell } = require('../src/services/export'));
  db.prepare('INSERT INTO guests (token, name) VALUES (?, ?)').run('danger', '=DANGER()');
});

describe('neutralizeCell — unit', () => {
  it('AC1: prepends apostrophe to dangerous leading characters', () => {
    expect(neutralizeCell('=1+1')).toBe("'=1+1");
    expect(neutralizeCell('+x')).toMatch(/^'/);
    expect(neutralizeCell('-x')).toMatch(/^'/);
    expect(neutralizeCell('@x')).toMatch(/^'/);
  });

  it('AC2: passes through safe strings and non-strings unchanged', () => {
    expect(neutralizeCell('Alice')).toBe('Alice');
    expect(neutralizeCell(42)).toBe(42);
  });
});

describe('buildSummaryBuffer — integration', () => {
  it('AC3: Guests sheet contains neutralized =DANGER() and no bare =DANGER()', async () => {
    const buf = await buildSummaryBuffer();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);

    const guestsSheet = wb.getWorksheet('Guests');
    expect(guestsSheet).toBeTruthy();

    let foundNeutralized = false;
    let foundBare = false;

    guestsSheet.eachRow((row) => {
      row.eachCell((cell) => {
        const val = cell.value;
        if (val === "'=DANGER()") foundNeutralized = true;
        if (val === '=DANGER()') foundBare = true;
      });
    });

    expect(foundNeutralized).toBe(true);
    expect(foundBare).toBe(false);
  });
});
