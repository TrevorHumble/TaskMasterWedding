// tests/upload-label.test.js
// AC1: uploadLabelText() drives the styled upload control's filename label.
'use strict';

describe('uploadLabelText() helper', () => {
  let uploadLabelText;

  beforeAll(() => {
    uploadLabelText = require('../src/public/js/upload-filename');
  });

  it('returns the filename when given a non-empty string', () => {
    expect(uploadLabelText('sunset.jpg')).toBe('sunset.jpg');
  });

  it('empty string falls back to the placeholder copy', () => {
    expect(uploadLabelText('')).toBe('Choose a photo…');
  });

  it('null falls back to the placeholder copy (no crash)', () => {
    expect(uploadLabelText(null)).toBe('Choose a photo…');
  });

  it('undefined falls back to the placeholder copy (no crash)', () => {
    expect(uploadLabelText(undefined)).toBe('Choose a photo…');
  });

  // Confirm the pass-through logic is exercised: an inverted implementation
  // (e.g. always returning the placeholder) must fail this.
  it('a chosen filename is not the placeholder (order/logic matters)', () => {
    expect(uploadLabelText('sunset.jpg')).not.toBe('Choose a photo…');
  });
});
