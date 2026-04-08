export function createStore(db) {
  const insertStmt = db.prepare(`
    INSERT INTO location_entries (username, device, lat, lon, tst, acc, vel, type, received_at, data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  return {
    appendEntry(entry) {
      insertStmt.run(
        entry.username ?? null,
        entry.device ?? null,
        entry.lat ?? null,
        entry.lon ?? null,
        entry.tst ?? null,
        entry.acc ?? null,
        entry.vel ?? null,
        entry.type ?? 'unknown',
        entry.received_at ?? new Date().toISOString(),
        JSON.stringify(entry)
      );
    },
  };
}
