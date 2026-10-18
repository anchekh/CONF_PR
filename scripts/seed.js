import { applyMigrations, openDatabase, seedDatabase } from '../src/database.js';

const db = openDatabase();
try {
  await applyMigrations(db);
  const includeDemoAdmin = process.env.NODE_ENV !== 'production' && process.env.SEED_DEMO_ADMIN !== 'false';
  await seedDatabase(db, { includeDemoAdmin });
  const rooms = (await db.query('SELECT count(*)::int AS count FROM rooms')).rows[0].count;
  const admins = (await db.query("SELECT count(*)::int AS count FROM users WHERE role = 'admin'")).rows[0].count;
  console.log(`Seed завершён: помещений ${rooms}, администраторов ${admins}.`);
} finally {
  await db.end();
}
