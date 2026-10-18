import pg from 'pg';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from './security.js';

const { Pool } = pg;
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_MIGRATIONS_PATH = resolve(projectRoot, 'db', 'migrations');

export function loadEnv() {
  const envFile = resolve(projectRoot, '.env');
  if (!existsSync(envFile)) return;
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const i = trimmed.indexOf('=');
    if (i < 1) continue;
    const key = trimmed.slice(0, i).trim();
    let value = trimmed.slice(i + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnv();

function checkedSchema(schema) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Недопустимое имя схемы PostgreSQL.');
  return schema;
}

export function openDatabase({ databaseUrl = process.env.DATABASE_URL, schema } = {}) {
  if (!databaseUrl) throw new Error('Укажите DATABASE_URL в файле .env (см. .env.example).');
  return new Pool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    ...(schema ? { options: `-c search_path=${checkedSchema(schema)}` } : {}),
  });
}

export async function applyMigrations(pool, migrationsPath = DEFAULT_MIGRATIONS_PATH) {
  const client = await pool.connect();
  const appliedNow = [];
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(726301, hashtext(current_schema() || chr(58) || current_database()))');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const applied = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
    for (const file of readdirSync(migrationsPath).filter((name) => name.endsWith('.sql')).sort()) {
      if (applied.has(file)) continue;
      await client.query(readFileSync(resolve(migrationsPath, file), 'utf8'));
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
      appliedNow.push(file);
    }
    await client.query('COMMIT');
    return appliedNow;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function seedDatabase(pool, { includeDemoAdmin = true } = {}) {
  const rooms = [
    ['Аудитория XXX', 'Аудитория', 80, 'Светлая аудитория с проектором и гибкой рассадкой.'],
    ['Коворкинг XXX', 'Коворкинг', 45, 'Открытое пространство для секций и командной работы.'],
    ['Кинозал XXX', 'Кинозал', 180, 'Зал с большой сценой, экраном и акустической системой.'],
  ];
  for (const room of rooms) {
    await pool.query(`INSERT INTO rooms (name, type, capacity, description)
      VALUES ($1, $2, $3, $4) ON CONFLICT (name) DO NOTHING`, room);
  }
  if (includeDemoAdmin) {
    await pool.query(`INSERT INTO users (login, password_hash, full_name, phone, email, role)
      VALUES ($1, $2, $3, $4, $5, 'admin') ON CONFLICT DO NOTHING`, [
      'Conf2027', hashPassword('Demo77'), 'Администратор Портала', '8(000)000-00-00', 'admin@conference.test',
    ]);
  }
}

export async function createIsolatedSchema(pool, schema) {
  await pool.query(`CREATE SCHEMA "${checkedSchema(schema)}"`);
}
export async function dropIsolatedSchema(pool, schema) {
  await pool.query(`DROP SCHEMA IF EXISTS "${checkedSchema(schema)}" CASCADE`);
}
