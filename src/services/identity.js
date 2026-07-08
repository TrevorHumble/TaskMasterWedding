// src/services/identity.js
// Contact normalization and PIN validation for the guest identity foundation
// (issue #239). One guest = one normalized contact (email or phone); the
// re-entry code guests type on any device is a plain 4-digit PIN.
//
// DELIBERATE DECISION — the PIN is stored UNHASHED in guests.pin (src/db.js).
// Do not "helpfully" hash it in a future change without re-opening this
// decision with the owner first. Rationale (owner-decided 2026-07-05, issue
// #239): the threat model here is guest mischief (a guest fumbling or
// guessing another guest's 4-digit code), not database compromise — whoever
// already holds data/app.db already holds every plaintext guests.token
// credential and every uploaded photo, so hashing a 4-digit PIN buys no real
// protection against that actor. What plaintext buys instead is Goal C: the
// admin recovery panel (#243) can read a PIN back out loud to a locked-out
// guest at the reception, on the spot, with no reset flow.
'use strict';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PIN_PATTERN = /^\d{4}$/;

/**
 * Normalize a guest-entered contact string into a canonical { type, value }
 * shape, so the same person typing 'Lilly@Example.COM' or '(208) 555-0142' on
 * different devices matches the same stored account.
 *
 * Email: trimmed and lowercased, must match a basic local@domain.tld shape.
 * Phone: every non-digit character stripped; a leading US country code ('1'
 * on an 11-digit number) is dropped; the remaining digit count must be in the
 * 10-15 range international numbers realistically fall in.
 *
 * @param {*} raw
 * @returns {{ type: 'email'|'phone', value: string }|null}
 */
function normalizeContact(raw) {
  if (typeof raw !== 'string') return null;

  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  if (EMAIL_PATTERN.test(lower)) {
    return { type: 'email', value: lower };
  }

  let digits = trimmed.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    digits = digits.slice(1);
  }
  if (digits.length >= 10 && digits.length <= 15) {
    return { type: 'phone', value: digits };
  }

  return null;
}

/**
 * True if `raw` is exactly 4 ASCII digits — the re-entry PIN shape.
 * @param {*} raw
 * @returns {boolean}
 */
function isValidPin(raw) {
  return typeof raw === 'string' && PIN_PATTERN.test(raw);
}

module.exports = { normalizeContact, isValidPin };
