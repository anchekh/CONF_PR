import { applyMigrations, openDatabase } from '../src/database.js';

const db = openDatabase();
try {
  const applied = await applyMigrations(db);
  console.log(applied.length ? `Применены миграции: ${applied.join(', ')}` : 'Схема PostgreSQL уже актуальна.');
} finally {
  await db.end();
}
