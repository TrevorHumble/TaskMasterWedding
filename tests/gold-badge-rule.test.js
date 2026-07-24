// tests/gold-badge-rule.test.js
// Unit tests for issue #710: gold rule — rank 1 renders the same badge gold, gold sorts first.

const { describe, it, expect } = require('vitest');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const scoring = require('../src/services/scoring');

describe('Issue #710: Gold badge rule & sorting', () => {
  const badgeArtPath = path.join(__dirname, '../src/views/partials/badge-art.ejs');
  const badgeArtTemplate = fs.readFileSync(badgeArtPath, 'utf8');

  // Helper function for badgeIsIcon in EJS context
  const renderBadgeArt = (badge, rank, extraLocals = {}) => {
    return ejs.render(badgeArtTemplate, {
      badge,
      rank,
      badgeIsIcon: (artPath) => typeof artPath === 'string' && artPath.startsWith('/badges/'),
      ...extraLocals,
    });
  };

  it('AC1: rank 1 badge renders badge-gold class, rank 2-5 does not', () => {
    const goldBadge = { name: 'Gold Task Medal', art_path: '/badges/star.svg', rank: 1 };
    const htmlGold = renderBadgeArt(goldBadge);
    expect(htmlGold).toContain('badge-gold');

    const silverBadge = { name: 'Silver Task Medal', art_path: '/badges/star.svg', rank: 2 };
    const htmlSilver = renderBadgeArt(silverBadge);
    expect(htmlSilver).not.toContain('badge-gold');

    const rank5Badge = { name: 'Rank 5 Medal', art_path: '/badges/star.svg', rank: 5 };
    const htmlRank5 = renderBadgeArt(rank5Badge);
    expect(htmlRank5).not.toContain('badge-gold');
  });

  it('AC1: passing explicit rank=1 local also renders badge-gold', () => {
    const plainBadge = { name: 'Plain Medal', art_path: '/badges/star.svg' };
    const htmlGold = renderBadgeArt(plainBadge, 1);
    expect(htmlGold).toContain('badge-gold');
  });

  it('AC3: compareBadgeMoment prioritizes rank 1 (gold) badges first', () => {
    const goldBadge = { type: 'custom', threshold: 5, code: 'GOLD1', rank: 1 };
    const autoBadge = { type: 'auto', threshold: 10, code: 'AUTO1', rank: null };

    // compareBadgeMoment(goldBadge, autoBadge) should return negative (gold first)
    const result = scoring.compareBadgeMoment(goldBadge, autoBadge);
    expect(result).toBeLessThan(0);

    const resultReverse = scoring.compareBadgeMoment(autoBadge, goldBadge);
    expect(resultReverse).toBeGreaterThan(0);
  });
});
