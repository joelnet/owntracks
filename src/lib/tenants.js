// Multi-business anchors (strip malls): one learned POI circle often covers
// several storefronts, so GPS alone can't tell which one was visited. The
// anchor row keeps a `tenants` JSON list of business names with pick counts,
// and per-day rows in visit_labels record which tenant a given day's visit was
// actually to. Detection always operates on the anchor; tenants and labels
// only change the names shown in journals, reports, and notifications.

// Matches the coordinate tolerance visit.renameLearnedPoi uses — learned
// anchors drift slightly as new visit centroids are averaged in, and the
// delete-all + reinsert persist makes row ids unstable, so anchors are
// identified by proximity rather than id.
export const ANCHOR_COORD_TOLERANCE = 0.001;

export function nearAnchor(lat1, lon1, lat2, lon2) {
  return Math.abs(lat1 - lat2) < ANCHOR_COORD_TOLERANCE
    && Math.abs(lon1 - lon2) < ANCHOR_COORD_TOLERANCE;
}

// tenants arrives from SQLite as a JSON string and lives in memory as an
// array of { name, visit_count, last_selected_at }. Returns null when the
// anchor has no tenant list.
export function parseTenants(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value.length > 0 ? value : null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

// Most-picked first; sort is stable, so ties keep insertion order (the
// anchor's original name was seeded first and wins a fresh tie).
export function orderTenants(tenants) {
  return [...tenants].sort((a, b) => (b.visit_count ?? 0) - (a.visit_count ?? 0));
}

// The name a stay at this POI gets when the user never picked a tenant.
export function defaultDisplayName(poi) {
  const tenants = parseTenants(poi.tenants);
  if (!tenants || tenants.length < 2) return poi.name;
  return orderTenants(tenants)[0].name;
}

// `date` is a local-day bucket key (YYYY-MM-DD in the journal timezone),
// matching how the journal names its files — not a timestamp.
export function getVisitLabel(db, lat, lon, date) {
  const rows = db.prepare('SELECT lat, lon, label FROM visit_labels WHERE date = ?').all(date);
  const match = rows.find(r => nearAnchor(r.lat, r.lon, lat, lon));
  return match ? match.label : null;
}

// One label per (anchor, local date) — picking again replaces the earlier pick.
export function setVisitLabel(db, lat, lon, date, label) {
  const rows = db.prepare('SELECT id, lat, lon FROM visit_labels WHERE date = ?').all(date);
  for (const row of rows) {
    if (nearAnchor(row.lat, row.lon, lat, lon)) {
      db.prepare('DELETE FROM visit_labels WHERE id = ?').run(row.id);
    }
  }
  db.prepare('INSERT INTO visit_labels (lat, lon, date, label, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(lat, lon, date, label, new Date().toISOString());
}

// Rewrite POI names in a replay config to what the journal/report should show
// for `date`: the day's picked tenant label when the user reacted or replied,
// else the anchor's most-picked tenant. Anchors without tenants (configured
// POIs, single-business learned POIs) keep their names, so the replay and its
// tuning baselines are untouched unless the tenant feature is in use.
export function applyDisplayNames(config, db, date) {
  if (!db) return config;
  let labels;
  try {
    labels = db.prepare('SELECT lat, lon, label FROM visit_labels WHERE date = ?').all(date);
  } catch {
    // Read-only DB predating the visit_labels migration (tuning replays).
    return config;
  }

  let changed = false;
  const locations = config.poi.locations.map(loc => {
    if (typeof loc.lat !== 'number' || typeof loc.lon !== 'number') return loc;
    const label = labels.find(l => nearAnchor(l.lat, l.lon, loc.lat, loc.lon));
    const name = label ? label.label : defaultDisplayName(loc);
    if (name === loc.name) return loc;
    changed = true;
    return { ...loc, name };
  });
  return changed ? { ...config, poi: { ...config.poi, locations } } : config;
}
