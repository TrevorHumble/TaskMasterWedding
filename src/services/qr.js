// src/services/qr.js
'use strict';

const QRCode = require('qrcode');

/**
 * Turn a full URL into a PNG "data URL" suitable for an <img src="...">.
 * The returned string looks like: data:image/png;base64,iVBORw0KGgo...
 *
 * @param {string} url  The full link to encode, e.g. https://x.trycloudflare.com/j/<token>
 * @returns {Promise<string>} a data URL string
 */
async function qrDataUrl(url) {
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error('qrDataUrl requires a non-empty URL string');
  }
  // margin:1 keeps the white border small; width:240 prints cleanly on a place-card.
  // errorCorrectionLevel 'M' tolerates a little print smudging while staying scannable.
  return QRCode.toDataURL(url, {
    margin: 1,
    width: 240,
    errorCorrectionLevel: 'M',
  });
}

module.exports = { qrDataUrl };
