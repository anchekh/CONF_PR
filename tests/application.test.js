import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createIsolatedSchema, dropIsolatedSchema, openDatabase } from '../src/database.js';
import { startApplication } from '../src/server.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = Boolean(databaseUrl && databaseUrl !== process.env.DATABASE_URL);
const skip = enabled ? false : 'Укажите TEST_DATABASE_URL, отличный от DATABASE_URL (отдельная тестовая БД).';
const schema = `conf_test_${randomBytes(8).toString('hex')}`;
let controlPool;
let application;
let baseUrl;

class TestClient {
  constructor() {
    this.cookie = '';
    this.csrfToken = '';
  }

  async request(path, { method = 'GET', body, csrf = true } = {}) {
    const headers = { Accept: 'application/json' };
    if (this.cookie) headers.Cookie = this.cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (csrf && body !== undefined && this.csrfToken) headers['X-CSRF-Token'] = this.csrfToken;
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    const data = await response.json();
    if (data.csrfToken) this.csrfToken = data.csrfToken;
    return { response, data };
  }

  async init() {
    return this.request('/api/auth/me');
  }
}

before(async () => {
  if (!enabled) return;
  controlPool = openDatabase({ databaseUrl });
  await createIsolatedSchema(controlPool, schema);
  const started = await startApplication({ databaseUrl, schema, port: 0, includeDemoAdmin: true });
  application = started.app;
  baseUrl = `http://127.0.0.1:${started.address.port}`;
});

after(async () => {
  if (!enabled) return;
  try {
    if (application) await application.close();
    if (controlPool) await dropIsolatedSchema(controlPool, schema);
  } finally {
    if (controlPool) await controlPool.end();
  }
});

test('AT-01/02/03: регистрация, уникальность и серверная валидация', { skip }, async () => {
  const user = new TestClient();
  await user.init();
  const valid = await user.request('/api/auth/register', {
    method: 'POST',
    body: { login: 'User2027', password: 'StrongPass77', fullName: 'Иванов Иван', phone: '8(999)123-45-67', email: 'ivanov@example.test' },
  });
  assert.equal(valid.response.status, 201);
  assert.equal(valid.data.user.login, 'User2027');

  const duplicate = new TestClient();
  await duplicate.init();
  const duplicateResult = await duplicate.request('/api/auth/register', {
    method: 'POST',
    body: { login: 'User2027', password: 'AnotherPass88', fullName: 'Петров Петр', phone: '8(999)555-11-22', email: 'petrov@example.test' },
  });
  assert.equal(duplicateResult.response.status, 409);
  assert.match(duplicateResult.data.errors.login, /занят/);

  const invalid = await duplicate.request('/api/auth/register', {
    method: 'POST',
    body: { login: 'юзер', password: 'short', fullName: 'John Doe', phone: '8999', email: 'bad' },
  });
  assert.equal(invalid.response.status, 422);
  assert.deepEqual(Object.keys(invalid.data.errors).sort(), ['email', 'fullName', 'login', 'password', 'phone']);
  const count = (await application.db.query("SELECT count(*)::int AS count FROM users WHERE role = 'user'")).rows[0].count;
  assert.equal(count, 1);
});

test('AT-04/09: неверный вход отклонён, пользователь и демо-администратор входят', { skip }, async () => {
  const client = new TestClient();
  await client.init();
  const denied = await client.request('/api/auth/login', { method: 'POST', body: { login: 'User2027', password: 'WrongPass' } });
  assert.equal(denied.response.status, 401);
  assert.equal(denied.data.message, 'Неверный логин или пароль.');
  const accepted = await client.request('/api/auth/login', { method: 'POST', body: { login: 'User2027', password: 'StrongPass77' } });
  assert.equal(accepted.response.status, 200);
  assert.equal(accepted.data.user.role, 'user');

  const admin = new TestClient();
  await admin.init();
  const adminLogin = await admin.request('/api/auth/login', { method: 'POST', body: { login: 'Conf2027', password: 'Demo77' } });
  assert.equal(adminLogin.response.status, 200);
  assert.equal(adminLogin.data.user.role, 'admin');
  const stored = (await application.db.query("SELECT password_hash FROM users WHERE login = 'Conf2027'")).rows[0].password_hash;
  assert.notEqual(stored, 'Demo77');
  assert.match(stored, /^scrypt\$/);
});

test('AT-05/06/07/08: создание, авторизация, изоляция и роль администратора', { skip }, async () => {
  const anonymous = new TestClient();
  await anonymous.init();
  const denied = await anonymous.request('/api/bookings', { method: 'POST', body: { roomId: 1, startAt: '2030-05-20T09:00:00.000Z', paymentMethod: 'СБП' } });
  assert.equal(denied.response.status, 401);

  const first = new TestClient();
  await first.init();
  await first.request('/api/auth/login', { method: 'POST', body: { login: 'User2027', password: 'StrongPass77' } });
  const created = await first.request('/api/bookings', { method: 'POST', body: { roomId: 1, startAt: '2030-05-20T09:00:00.000Z', paymentMethod: 'СБП' } });
  assert.equal(created.response.status, 201);
  assert.equal(created.data.booking.status, 'Новая');

  const second = new TestClient();
  await second.init();
  await second.request('/api/auth/register', { method: 'POST', body: { login: 'Second7', password: 'SecurePass88', fullName: 'Петров Петр', phone: '8(999)555-11-22', email: 'second@example.test' } });
  const secondBooking = await second.request('/api/bookings', { method: 'POST', body: { roomId: 2, startAt: '2030-06-21T10:00:00.000Z', paymentMethod: 'При очном посещении' } });
  assert.equal(secondBooking.response.status, 201);
  const mineFirst = await first.request('/api/bookings/my');
  const mineSecond = await second.request('/api/bookings/my');
  assert.equal(mineFirst.data.bookings.length, 1);
  assert.equal(mineSecond.data.bookings.length, 1);
  assert.notEqual(mineFirst.data.bookings[0].id, mineSecond.data.bookings[0].id);

  const adminDenied = await first.request('/api/admin/bookings');
  assert.equal(adminDenied.response.status, 403);
  const csrfDenied = await first.request('/api/bookings', { method: 'POST', csrf: false, body: { roomId: 1, startAt: '2030-07-01T09:00:00.000Z', paymentMethod: 'СБП' } });
  assert.equal(csrfDenied.response.status, 403);
});

test('AT-10/11/12/13: фильтр, статусы и отзывы', { skip }, async () => {
  const first = new TestClient();
  await first.init();
  await first.request('/api/auth/login', { method: 'POST', body: { login: 'User2027', password: 'StrongPass77' } });
  const firstBooking = (await first.request('/api/bookings/my')).data.bookings[0];

  const second = new TestClient();
  await second.init();
  await second.request('/api/auth/login', { method: 'POST', body: { login: 'Second7', password: 'SecurePass88' } });
  const secondBooking = (await second.request('/api/bookings/my')).data.bookings[0];
  const premature = await second.request(`/api/bookings/${secondBooking.id}/reviews`, { method: 'POST', body: { text: 'Отзыв до завершения должен быть запрещён.' } });
  assert.equal(premature.response.status, 409);

  const admin = new TestClient();
  await admin.init();
  await admin.request('/api/auth/login', { method: 'POST', body: { login: 'Conf2027', password: 'Demo77' } });
  const all = await admin.request('/api/admin/bookings');
  assert.equal(all.data.bookings.length, 2);
  const filteredNew = await admin.request(`/api/admin/bookings?status=${encodeURIComponent('Новая')}`);
  assert.equal(filteredNew.data.bookings.length, 2);
  const scheduled = await admin.request(`/api/admin/bookings/${firstBooking.id}/status`, { method: 'PATCH', body: { status: 'Мероприятие назначено' } });
  assert.equal(scheduled.response.status, 200);
  const completed = await admin.request(`/api/admin/bookings/${firstBooking.id}/status`, { method: 'PATCH', body: { status: 'Завершено' } });
  assert.equal(completed.response.status, 200);
  const filteredCompleted = await admin.request(`/api/admin/bookings?status=${encodeURIComponent('Завершено')}`);
  assert.equal(filteredCompleted.data.bookings.length, 1);

  const review = await first.request(`/api/bookings/${firstBooking.id}/reviews`, { method: 'POST', body: { text: 'Организация прошла чётко, зал и оборудование подошли.' } });
  assert.equal(review.response.status, 201);
  assert.equal(review.data.booking.reviewText, 'Организация прошла чётко, зал и оборудование подошли.');
  const duplicate = await first.request(`/api/bookings/${firstBooking.id}/reviews`, { method: 'POST', body: { text: 'Повторный отзыв сохраняться не должен.' } });
  assert.equal(duplicate.response.status, 409);
});

test('AT-15: health endpoint подтверждает связь с БД', { skip }, async () => {
  const client = new TestClient();
  const result = await client.request('/api/health');
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.data, { status: 'ok', database: 'connected' });
});
