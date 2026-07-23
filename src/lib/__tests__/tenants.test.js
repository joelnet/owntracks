import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initSchema } from '../db.js';
import {
  parseTenants,
  orderTenants,
  defaultDisplayName,
  nearAnchor,
  getVisitLabel,
  setVisitLabel,
  applyDisplayNames,
} from '../tenants.js';

describe('parseTenants', () => {
  it('parses a JSON string from SQLite', () => {
    const tenants = parseTenants('[{"name":"Starbucks","visit_count":3}]');
    assert.equal(tenants.length, 1);
    assert.equal(tenants[0].name, 'Starbucks');
  });

  it('passes arrays through', () => {
    const arr = [{ name: 'A', visit_count: 1 }];
    assert.equal(parseTenants(arr), arr);
  });

  it('returns null for null, invalid JSON, and empty lists', () => {
    assert.equal(parseTenants(null), null);
    assert.equal(parseTenants(undefined), null);
    assert.equal(parseTenants('not json'), null);
    assert.equal(parseTenants('[]'), null);
    assert.equal(parseTenants([]), null);
  });
});

describe('orderTenants / defaultDisplayName', () => {
  it('orders by pick count, keeping insertion order on ties', () => {
    const ordered = orderTenants([
      { name: 'Anchor', visit_count: 2 },
      { name: 'Salon', visit_count: 5 },
      { name: 'Tied', visit_count: 2 },
    ]);
    assert.deepEqual(ordered.map(t => t.name), ['Salon', 'Anchor', 'Tied']);
  });

  it('defaults to the most-picked tenant name', () => {
    const poi = {
      name: 'Starbucks',
      tenants: JSON.stringify([
        { name: 'Starbucks', visit_count: 2 },
        { name: 'Nail Salon', visit_count: 4 },
      ]),
    };
    assert.equal(defaultDisplayName(poi), 'Nail Salon');
  });

  it('falls back to the anchor name without at least two tenants', () => {
    assert.equal(defaultDisplayName({ name: 'Solo', tenants: null }), 'Solo');
    assert.equal(
      defaultDisplayName({ name: 'Solo', tenants: JSON.stringify([{ name: 'X', visit_count: 9 }]) }),
      'Solo'
    );
  });
});

describe('visit labels', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
  });

  it('stores and reads back a label by anchor proximity', () => {
    setVisitLabel(db, 34.0170, -117.9030, '2026-07-23', 'Nail Salon');
    // Query with slightly drifted anchor coordinates.
    assert.equal(getVisitLabel(db, 34.0175, -117.9034, '2026-07-23'), 'Nail Salon');
    assert.equal(getVisitLabel(db, 34.0170, -117.9030, '2026-07-22'), null);
    assert.equal(getVisitLabel(db, 34.1000, -117.9030, '2026-07-23'), null);
  });

  it('replaces an earlier pick for the same anchor and day', () => {
    setVisitLabel(db, 34.017, -117.903, '2026-07-23', 'Nail Salon');
    setVisitLabel(db, 34.017, -117.903, '2026-07-23', 'UPS Store');
    assert.equal(getVisitLabel(db, 34.017, -117.903, '2026-07-23'), 'UPS Store');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM visit_labels').get().n, 1);
  });

  it('keeps labels for different anchors on the same day', () => {
    setVisitLabel(db, 34.017, -117.903, '2026-07-23', 'Nail Salon');
    setVisitLabel(db, 34.100, -117.800, '2026-07-23', 'Bakery');
    assert.equal(getVisitLabel(db, 34.017, -117.903, '2026-07-23'), 'Nail Salon');
    assert.equal(getVisitLabel(db, 34.100, -117.800, '2026-07-23'), 'Bakery');
  });
});

describe('applyDisplayNames', () => {
  let db;
  const anchor = {
    name: 'Starbucks',
    lat: 34.017,
    lon: -117.903,
    radius_m: 100,
    tenants: JSON.stringify([
      { name: 'Starbucks', visit_count: 1 },
      { name: 'Nail Salon', visit_count: 3 },
    ]),
  };
  const home = { name: 'Home', lat: 34.5, lon: -117.5, radius_m: 100 };

  const configWith = (locations) => ({ poi: { default_radius_m: 100, locations } });

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
  });

  it('uses the day label when one was picked', () => {
    setVisitLabel(db, 34.017, -117.903, '2026-07-23', 'UPS Store');
    const config = applyDisplayNames(configWith([home, anchor]), db, '2026-07-23');
    assert.deepEqual(config.poi.locations.map(l => l.name), ['Home', 'UPS Store']);
  });

  it('falls back to the most-picked tenant without a label', () => {
    const config = applyDisplayNames(configWith([home, anchor]), db, '2026-07-23');
    assert.deepEqual(config.poi.locations.map(l => l.name), ['Home', 'Nail Salon']);
  });

  it('returns the config unchanged when nothing applies', () => {
    const config = configWith([home]);
    assert.equal(applyDisplayNames(config, db, '2026-07-23'), config);
    assert.equal(applyDisplayNames(config, null, '2026-07-23'), config);
  });

  it('does not mutate the input config', () => {
    const config = configWith([home, anchor]);
    applyDisplayNames(config, db, '2026-07-23');
    assert.equal(config.poi.locations[1].name, 'Starbucks');
  });

  it('skips multi-anchor configured POIs without top-level coordinates', () => {
    const multi = { name: 'Work', points: [{ lat: 34.6, lon: -117.6 }] };
    const config = applyDisplayNames(configWith([multi, anchor]), db, '2026-07-23');
    assert.deepEqual(config.poi.locations.map(l => l.name), ['Work', 'Nail Salon']);
  });
});

describe('nearAnchor', () => {
  it('matches within the coordinate tolerance only', () => {
    assert.equal(nearAnchor(34.017, -117.903, 34.0175, -117.9035), true);
    assert.equal(nearAnchor(34.017, -117.903, 34.019, -117.903), false);
  });
});
