// src/services/badge-icons.js
//
// Issue #410: the SINGLE owner of the bundled badge-icon catalog. Enumerates
// the ~200 bare SVGs vendored under src/public/badges/icons/ (Material
// Symbols, recolored, Apache-2.0 — see that directory's LICENSE/
// ATTRIBUTION.md), validates a picked icon id, and resolves an id to its
// public path. Every caller that needs "the list of pickable icons" or "is
// this id real" goes through this module — the picker partial no longer
// inlines the array (phase-1's admin-tasks.ejs did; this replaces it), and
// POST /admin/tasks/:id/badge validates every posted id here before it ever
// reaches task-badges.setTaskBadge.
//
// No CDN, no network fetch: the catalog is a hard-coded array checked at
// require() time against the files actually on disk (fail at boot if the
// two drift, not silently at pick time) — the offline guarantee (AC1) is a
// property of express.static serving local files, not of this module, but
// this module is what stops a catalog entry from ever pointing at a file
// that was never bundled.
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../../config');

// Where the bundled SVGs live on disk and the URL prefix express.static
// (app.js's `app.use(express.static(config.PUBLIC_DIR))`) serves them under.
// Single owner of both — resolveIconPath below is the only place either is
// used to build a public path.
const ICONS_DIR = path.join(config.PUBLIC_DIR, 'badges', 'icons');
const ICONS_URL_PREFIX = '/badges/icons/';

// Stag-variant (issue #640) bare-icon path prefix. The three black-tie
// milestone badges (First Round/Second Round/Last Call — scripts/badge-catalog.js's
// STAG_BADGES) point their art_path at a gold-on-dark recolor of a bundled
// Material icon, vendored under src/public/badges/stag/icons/ instead of the
// wedding ICONS_DIR above (AC4: the wedding icon files stay byte-unchanged).
// This module does NOT maintain a second pickable catalog for these — the
// admin custom-badge icon PICKER (listIcons/resolveIconPath below) stays
// wedding-icon-only; no acceptance criterion asks the stag admin to pick from
// a gold-recolored ~200-icon set. Only the isIconArtPath prefix test below
// needs to recognize this second prefix, so a stag milestone badge's art_path
// still renders as a bare icon inside the gold medallion (badge-art.ejs)
// instead of falling through to the composed-image branch.
const STAG_ICONS_DIR = path.join(config.PUBLIC_DIR, 'badges', 'stag', 'icons');
const STAG_ICONS_URL_PREFIX = '/badges/stag/icons/';
// The exact three milestone icon ids the stag catalog references. Checked at
// require() time — same fail-fast-at-boot idea as the wedding ICONS
// assertions below — so a missing stag icon file breaks the boot loudly
// instead of 404ing silently the first time a guest earns the badge.
const STAG_MILESTONE_ICON_IDS = ['sports-bar', 'liquor', 'nightlife'];
for (const stagId of STAG_MILESTONE_ICON_IDS) {
  const stagFilePath = path.join(STAG_ICONS_DIR, `${stagId}.svg`);
  if (!fs.existsSync(stagFilePath)) {
    throw new Error(
      `badge-icons: stag milestone icon "${stagId}" has no bundled SVG at ${stagFilePath}`
    );
  }
}

// Curated id -> display-name pairs (owner-approved 2026-07-19, carried over
// verbatim from the phase-1 inline array in src/views/admin-tasks.ejs). `id`
// is the bundled SVG's bare filename (no extension); `name` is what the
// picker shows and what auto-fills the badge-name field on pick.
const ICONS = [
  { id: 'favorite', name: 'Heart' },
  { id: 'diamond', name: 'Diamond' },
  { id: 'volunteer-activism', name: 'Heart Hands' },
  { id: 'handshake', name: 'Vows' },
  { id: 'diversity-1', name: 'Together' },
  { id: 'diversity-3', name: 'Circle' },
  { id: 'groups', name: 'Guests' },
  { id: 'group', name: 'Party' },
  { id: 'family-restroom', name: 'Family' },
  { id: 'pregnant-woman', name: 'Expecting' },
  { id: 'child-friendly', name: 'Little One' },
  { id: 'elderly', name: 'Elders' },
  { id: 'ring-volume', name: 'Ring' },
  { id: 'celebration', name: 'Celebrate' },
  { id: 'festival', name: 'Festival' },
  { id: 'nightlife', name: 'Night Out' },
  { id: 'local-activity', name: 'Ticket' },
  { id: 'confirmation-number', name: 'Pass' },
  { id: 'redeem', name: 'Gift' },
  { id: 'trophy', name: 'Trophy' },
  { id: 'workspace-premium', name: 'Medal' },
  { id: 'military-tech', name: 'Honor' },
  { id: 'verified', name: 'Verified' },
  { id: 'kid-star', name: 'Star Badge' },
  { id: 'star', name: 'Star' },
  { id: 'stars', name: 'Stars' },
  { id: 'bolt', name: 'Spark' },
  { id: 'cake', name: 'Cake' },
  { id: 'restaurant', name: 'Dining' },
  { id: 'dining', name: 'Table' },
  { id: 'dinner-dining', name: 'Dinner' },
  { id: 'lunch-dining', name: 'Lunch' },
  { id: 'brunch-dining', name: 'Brunch' },
  { id: 'bakery-dining', name: 'Pastry' },
  { id: 'ramen-dining', name: 'Noodles' },
  { id: 'local-pizza', name: 'Pizza' },
  { id: 'local-dining', name: 'Fork & Knife' },
  { id: 'icecream', name: 'Ice Cream' },
  { id: 'cookie', name: 'Cookie' },
  { id: 'egg', name: 'Egg' },
  { id: 'set-meal', name: 'Plated' },
  { id: 'wine-bar', name: 'Wine' },
  { id: 'liquor', name: 'Spirits' },
  { id: 'local-bar', name: 'Cocktail' },
  { id: 'sports-bar', name: 'Beer' },
  { id: 'coffee', name: 'Coffee' },
  { id: 'local-cafe', name: 'Cafe' },
  { id: 'nutrition', name: 'Fresh' },
  { id: 'grocery', name: 'Market' },
  { id: 'toast', name: 'Toast' },
  { id: 'local-florist', name: 'Flower' },
  { id: 'potted-plant', name: 'Plant' },
  { id: 'yard', name: 'Garden' },
  { id: 'grass', name: 'Grass' },
  { id: 'eco', name: 'Leaf' },
  { id: 'spa', name: 'Bloom' },
  { id: 'forest', name: 'Forest' },
  { id: 'park', name: 'Tree' },
  { id: 'nature', name: 'Nature' },
  { id: 'water-drop', name: 'Dew' },
  { id: 'pets', name: 'Pet' },
  { id: 'cruelty-free', name: 'Bunny' },
  { id: 'flutter-dash', name: 'Bird' },
  { id: 'egg-alt', name: 'Nest' },
  { id: 'sunny', name: 'Sun' },
  { id: 'clear-day', name: 'Clear Day' },
  { id: 'partly-cloudy-day', name: 'Cloudy' },
  { id: 'cloud', name: 'Cloud' },
  { id: 'nightlight', name: 'Moon' },
  { id: 'moon-stars', name: 'Moon & Stars' },
  { id: 'bedtime', name: 'Crescent' },
  { id: 'rainy', name: 'Rain' },
  { id: 'snowflake', name: 'Snow' },
  { id: 'umbrella', name: 'Umbrella' },
  { id: 'air', name: 'Breeze' },
  { id: 'mode-fan', name: 'Fan' },
  { id: 'flight', name: 'Flight' },
  { id: 'luggage', name: 'Getaway' },
  { id: 'train', name: 'Train' },
  { id: 'directions-boat', name: 'Boat' },
  { id: 'sailing', name: 'Sailing' },
  { id: 'directions-car', name: 'Car' },
  { id: 'two-wheeler', name: 'Scooter' },
  { id: 'pedal-bike', name: 'Bike' },
  { id: 'hiking', name: 'Hike' },
  { id: 'beach-access', name: 'Beach' },
  { id: 'pool', name: 'Pool' },
  { id: 'waves', name: 'Waves' },
  { id: 'home', name: 'Home' },
  { id: 'cottage', name: 'Cottage' },
  { id: 'castle', name: 'Castle' },
  { id: 'church', name: 'Chapel' },
  { id: 'key', name: 'Key' },
  { id: 'savings', name: 'Savings' },
  { id: 'map', name: 'Map' },
  { id: 'explore', name: 'Explore' },
  { id: 'music-note', name: 'Music' },
  { id: 'queue-music', name: 'Playlist' },
  { id: 'mic', name: 'Mic' },
  { id: 'piano', name: 'Piano' },
  { id: 'theater-comedy', name: 'Theatre' },
  { id: 'palette', name: 'Palette' },
  { id: 'brush', name: 'Brush' },
  { id: 'casino', name: 'Dice' },
  { id: 'sports-esports', name: 'Games' },
  { id: 'toys', name: 'Toys' },
  { id: 'photo-camera', name: 'Camera' },
  { id: 'camera', name: 'Snapshot' },
  { id: 'videocam', name: 'Video' },
  { id: 'photo', name: 'Photo' },
  { id: 'fireplace', name: 'Fireplace' },
  { id: 'local-fire-department', name: 'Flame' },
  { id: 'candle', name: 'Candle' },
  { id: 'light', name: 'Lantern' },
  { id: 'gesture', name: 'Flourish' },
  { id: 'mood', name: 'Smile' },
  { id: 'sentiment-very-satisfied', name: 'Joy' },
  { id: 'waving-hand', name: 'Wave Hello' },
  { id: 'front-hand', name: 'Hello' },
  { id: 'thumb-up', name: 'Cheers' },
  { id: 'sign-language', name: 'Sign' },
  { id: 'face', name: 'Guest' },
  { id: 'fastfood', name: 'Fast Food' },
  { id: 'tapas', name: 'Tapas' },
  { id: 'bento', name: 'Bento' },
  { id: 'kebab-dining', name: 'Kebab' },
  { id: 'soup-kitchen', name: 'Soup' },
  { id: 'rice-bowl', name: 'Rice Bowl' },
  { id: 'outdoor-grill', name: 'Grill' },
  { id: 'breakfast-dining', name: 'Breakfast' },
  { id: 'room-service', name: 'Room Service' },
  { id: 'takeout-dining', name: 'Takeout' },
  { id: 'emoji-food-beverage', name: 'Tea' },
  { id: 'blender', name: 'Blender' },
  { id: 'coffee-maker', name: 'Coffee Pot' },
  { id: 'microwave', name: 'Microwave' },
  { id: 'kitchen', name: 'Kitchen' },
  { id: 'thunderstorm', name: 'Thunder' },
  { id: 'tornado', name: 'Twister' },
  { id: 'foggy', name: 'Fog' },
  { id: 'mode-night', name: 'Night' },
  { id: 'landscape', name: 'Landscape' },
  { id: 'compost', name: 'Compost' },
  { id: 'recycling', name: 'Recycle' },
  { id: 'agriculture', name: 'Harvest' },
  { id: 'emoji-nature', name: 'Bee' },
  { id: 'water-full', name: 'Water' },
  { id: 'storm', name: 'Storm' },
  { id: 'filter-vintage', name: 'Vintage' },
  { id: 'sports-soccer', name: 'Soccer' },
  { id: 'sports-basketball', name: 'Basketball' },
  { id: 'sports-tennis', name: 'Tennis' },
  { id: 'sports-volleyball', name: 'Volleyball' },
  { id: 'sports-golf', name: 'Golf' },
  { id: 'sports-baseball', name: 'Baseball' },
  { id: 'sports-football', name: 'Football' },
  { id: 'sports-cricket', name: 'Cricket' },
  { id: 'sports-hockey', name: 'Hockey' },
  { id: 'sports-handball', name: 'Handball' },
  { id: 'sports', name: 'Sports' },
  { id: 'fitness-center', name: 'Fitness' },
  { id: 'self-improvement', name: 'Meditate' },
  { id: 'sports-gymnastics', name: 'Gymnastics' },
  { id: 'skateboarding', name: 'Skate' },
  { id: 'roller-skating', name: 'Roller Skate' },
  { id: 'ice-skating', name: 'Ice Skate' },
  { id: 'rowing', name: 'Rowing' },
  { id: 'kayaking', name: 'Kayak' },
  { id: 'surfing', name: 'Surf' },
  { id: 'scuba-diving', name: 'Diving' },
  { id: 'downhill-skiing', name: 'Ski' },
  { id: 'snowboarding', name: 'Snowboard' },
  { id: 'golf-course', name: 'Golf Course' },
  { id: 'flight-takeoff', name: 'Takeoff' },
  { id: 'flight-land', name: 'Landing' },
  { id: 'hotel', name: 'Hotel' },
  { id: 'king-bed', name: 'Bed' },
  { id: 'cabin', name: 'Cabin' },
  { id: 'houseboat', name: 'Houseboat' },
  { id: 'camping', name: 'Camping' },
  { id: 'holiday-village', name: 'Village' },
  { id: 'local-taxi', name: 'Taxi' },
  { id: 'directions-bus', name: 'Bus' },
  { id: 'tram', name: 'Tram' },
  { id: 'anchor', name: 'Anchor' },
  { id: 'rocket-launch', name: 'Rocket' },
  { id: 'travel-explore', name: 'Globe' },
  { id: 'attractions', name: 'Attractions' },
  { id: 'museum', name: 'Museum' },
  { id: 'temple-buddhist', name: 'Temple' },
  { id: 'stadium', name: 'Stadium' },
  { id: 'sentiment-satisfied', name: 'Content' },
  { id: 'man', name: 'Man' },
  { id: 'woman', name: 'Woman' },
  { id: 'person', name: 'Person' },
  { id: 'groups-2', name: 'Crowd' },
  { id: 'stroller', name: 'Stroller' },
  { id: 'back-hand', name: 'High Five' },
  { id: 'photo-library', name: 'Photo Album' },
  { id: 'library-music', name: 'Music Library' },
];

// Fail at require() time — before any request is ever served — if the
// catalog and the bundled files on disk have drifted apart in either
// direction: a catalog entry with no file would 404 in the picker/render
// path, and (less harmfully, but still a bug) a bundled file with no
// catalog entry could never be picked. Both are cheap to catch here once,
// rather than per-request in the routes below.
const ICON_BY_ID = new Map();
for (const icon of ICONS) {
  const filePath = path.join(ICONS_DIR, `${icon.id}.svg`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`badge-icons: catalog entry "${icon.id}" has no bundled SVG at ${filePath}`);
  }
  if (ICON_BY_ID.has(icon.id)) {
    throw new Error(`badge-icons: duplicate catalog id "${icon.id}"`);
  }
  ICON_BY_ID.set(icon.id, icon);
}
const bundledSvgCount = fs.readdirSync(ICONS_DIR).filter((f) => f.endsWith('.svg')).length;
if (bundledSvgCount !== ICONS.length) {
  throw new Error(
    `badge-icons: ${bundledSvgCount} SVG file(s) under ${ICONS_DIR} but the catalog lists ${ICONS.length} — every bundled file needs a catalog entry (and vice versa)`
  );
}

/**
 * The full pickable catalog, in display order. Returns a fresh array each
 * call (shallow copy) so a caller (e.g. the picker partial's forEach) can
 * never mutate the module's own list.
 *
 * @returns {{id: string, name: string}[]}
 */
function listIcons() {
  return ICONS.slice();
}

/**
 * True only for an id that is both a non-empty string AND present in the
 * catalog — the single validation gate the admin route runs a posted `icon`
 * field through before it ever reaches task-badges.setTaskBadge (AC2's
 * "the task's badge is stored as that icon" only ever happens for a real
 * catalog id; anything else — empty, unknown, path-traversal-shaped,
 * wrong-typed — is refused here rather than trusted to resolveIconPath's
 * path.join, which itself never leaves ICONS_DIR because it only ever joins
 * a Map-verified id).
 *
 * @param {unknown} id
 * @returns {boolean}
 */
function isValidIconId(id) {
  return typeof id === 'string' && ICON_BY_ID.has(id);
}

/**
 * Resolve a validated icon id to its public `/badges/icons/<id>.svg` path
 * (the art_path stored on the task's badge row). Returns null for an
 * invalid id instead of building a path from unchecked input — callers
 * that skip isValidIconId and call this directly still cannot be handed a
 * path outside ICONS_DIR, because a Map miss short-circuits before any
 * string concatenation happens.
 *
 * @param {unknown} id
 * @returns {string|null}
 */
function resolveIconPath(id) {
  if (!isValidIconId(id)) return null;
  return ICONS_URL_PREFIX + id + '.svg';
}

/**
 * Alias for resolveIconPath, named for the call sites (the picker route/view)
 * that just want "the art path for this id" rather than caring that it's a
 * resolve-and-validate step. Same function; two names for two audiences.
 *
 * @param {unknown} id
 * @returns {string|null}
 */
const iconArtPath = resolveIconPath;

/**
 * True only if the given art_path string is a bundled catalog icon's path
 * (i.e. starts with the wedding ICONS_URL_PREFIX this module owns, OR the
 * stag STAG_ICONS_URL_PREFIX above — issue #640), false for any other value
 * including a composed/system badge's own circle SVG. The single place that
 * encapsulates both bare-icon prefixes so no other module needs to know
 * either literal to tell an icon badge from a composed one.
 *
 * @param {unknown} artPath
 * @returns {boolean}
 */
function isIconArtPath(artPath) {
  return (
    typeof artPath === 'string' &&
    (artPath.indexOf(ICONS_URL_PREFIX) === 0 || artPath.indexOf(STAG_ICONS_URL_PREFIX) === 0)
  );
}

/**
 * The catalog display name for a validated icon id, or null if the id is
 * not in the catalog. Used to auto-suggest the badge-name field's value —
 * the SAME name the picker grid's tooltip and data-name attribute carry, so
 * client and server never disagree about what an icon is called.
 *
 * @param {unknown} id
 * @returns {string|null}
 */
function iconName(id) {
  const icon = ICON_BY_ID.get(id);
  return icon ? icon.name : null;
}

module.exports = {
  ICONS_URL_PREFIX,
  STAG_ICONS_URL_PREFIX,
  listIcons,
  isValidIconId,
  resolveIconPath,
  iconArtPath,
  isIconArtPath,
  iconName,
};
