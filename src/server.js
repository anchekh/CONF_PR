import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { applyMigrations, openDatabase, seedDatabase } from './database.js';
import { AdminService, AppError, AuthService, BookingService } from './services.js';
import { parseCookies, randomToken, safeTokenEquals, sessionCookie } from './security.js';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(moduleDir, '..');
const publicRoot = resolve(projectRoot, 'public');

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > 1_000_000) throw new AppError(413, 'Слишком большой запрос.');
  }
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new AppError(400, 'Некорректный JSON.');
  }
}

export class ConferenceApplication {
  constructor({ db, secureCookie = false } = {}) {
    this.db = db;
    this.auth = new AuthService(db);
    this.bookings = new BookingService(db);
    this.admin = new AdminService(db);
    this.secureCookie = secureCookie;
    this.server = createServer(this.handle.bind(this));
  }

  static async create({ databaseUrl, schema, includeDemoAdmin = true, secureCookie = false } = {}) {
    const db = openDatabase({ databaseUrl, schema });
    try {
      await applyMigrations(db);
      await seedDatabase(db, { includeDemoAdmin });
      return new ConferenceApplication({ db, secureCookie });
    } catch (error) {
      await db.end();
      throw error;
    }
  }

  async listen({ port = 3000, host = '127.0.0.1' } = {}) {
    await new Promise((resolveListen, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, resolveListen);
    });
    return this.server.address();
  }

  async close() {
    if (this.server.listening) await new Promise((resolveClose) => this.server.close(resolveClose));
    await this.db.end();
  }

  async createSession(res, userId = null) {
    const id = randomToken();
    const csrfToken = randomToken();
    const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
    await this.db.query('INSERT INTO sessions (id, user_id, csrf_token, expires_at) VALUES ($1, $2, $3, $4)',
      [id, userId, csrfToken, expiresAt]);
    res.setHeader('Set-Cookie', sessionCookie(id, { secure: this.secureCookie }));
    return { id, user_id: userId, csrf_token: csrfToken, expires_at: expiresAt };
  }

  async getSession(req, res, { create = false } = {}) {
    const sid = parseCookies(req.headers.cookie).sid;
    if (sid) {
      const result = await this.db.query('SELECT * FROM sessions WHERE id = $1 AND expires_at > now()', [sid]);
      if (result.rows[0]) return result.rows[0];
    }
    return create ? this.createSession(res) : null;
  }

  async rotateSession(res, oldSessionId, userId = null) {
    if (oldSessionId) await this.db.query('DELETE FROM sessions WHERE id = $1', [oldSessionId]);
    return this.createSession(res, userId);
  }

  requireCsrf(req, session) {
    if (!session || !safeTokenEquals(session.csrf_token, req.headers['x-csrf-token'])) {
      throw new AppError(403, 'Недействительный CSRF-токен. Обновите страницу.');
    }
  }

  async requireUser(req, res) {
    const session = await this.getSession(req, res);
    if (!session?.user_id) throw new AppError(401, 'Требуется авторизация.');
    const result = await this.db.query('SELECT * FROM users WHERE id = $1', [session.user_id]);
    const user = result.rows[0];
    if (!user) throw new AppError(401, 'Сессия недействительна.');
    return { session, user };
  }

  async requireAdmin(req, res) {
    const context = await this.requireUser(req, res);
    if (context.user.role !== 'admin') throw new AppError(403, 'Доступ разрешён только администратору.');
    return context;
  }

  setSecurityHeaders(res) {
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  }

  async handle(req, res) {
    this.setSecurityHeaders(res);
    try {
      const url = new URL(req.url, 'http://local');
      const { pathname } = url;

      if (pathname.startsWith('/api/')) {
        res.setHeader('Cache-Control', 'no-store');
        await this.handleApi(req, res, url);
        return;
      }
      this.serveStatic(res, pathname);
    } catch (error) {
      const known = error instanceof AppError;
      if (!known) console.error(error);
      json(res, known ? error.status : 500, {
        message: known ? error.message : 'Внутренняя ошибка сервера.',
        ...(known && error.errors ? { errors: error.errors } : {}),
      });
    }
  }

  async handleApi(req, res, url) {
    const { pathname, searchParams } = url;
    const method = req.method || 'GET';

    if (method === 'GET' && pathname === '/api/health') {
      await this.db.query('SELECT 1');
      json(res, 200, { status: 'ok', database: 'connected' });
      return;
    }
    if (method === 'GET' && pathname === '/api/auth/me') {
      const session = await this.getSession(req, res, { create: true });
      const user = session.user_id ? (await this.db.query('SELECT * FROM users WHERE id = $1', [session.user_id])).rows[0] : null;
      json(res, 200, { user: this.auth.publicUser(user), csrfToken: session.csrf_token });
      return;
    }
    if (method === 'POST' && pathname === '/api/auth/register') {
      const session = await this.getSession(req, res, { create: true });
      this.requireCsrf(req, session);
      const user = await this.auth.register(await readJson(req));
      const nextSession = await this.rotateSession(res, session.id, user.id);
      json(res, 201, { user, csrfToken: nextSession.csrf_token, message: 'Регистрация завершена.' });
      return;
    }
    if (method === 'POST' && pathname === '/api/auth/login') {
      const session = await this.getSession(req, res, { create: true });
      this.requireCsrf(req, session);
      const user = await this.auth.login(await readJson(req));
      const nextSession = await this.rotateSession(res, session.id, user.id);
      json(res, 200, { user, csrfToken: nextSession.csrf_token, message: 'Вы вошли в систему.' });
      return;
    }
    if (method === 'POST' && pathname === '/api/auth/logout') {
      const session = await this.getSession(req, res, { create: true });
      this.requireCsrf(req, session);
      const nextSession = await this.rotateSession(res, session.id);
      json(res, 200, { csrfToken: nextSession.csrf_token, message: 'Вы вышли из системы.' });
      return;
    }
    if (method === 'GET' && pathname === '/api/rooms') {
      json(res, 200, { rooms: await this.bookings.listRooms() });
      return;
    }
    if (method === 'POST' && pathname === '/api/bookings') {
      const { session, user } = await this.requireUser(req, res);
      this.requireCsrf(req, session);
      json(res, 201, { booking: await this.bookings.create(user.id, await readJson(req)), message: 'Заявка отправлена.' });
      return;
    }
    if (method === 'GET' && pathname === '/api/bookings/my') {
      const { user } = await this.requireUser(req, res);
      json(res, 200, { bookings: await this.bookings.listMine(user.id) });
      return;
    }
    const reviewMatch = pathname.match(/^\/api\/bookings\/(\d+)\/reviews$/);
    if (method === 'POST' && reviewMatch) {
      const { session, user } = await this.requireUser(req, res);
      this.requireCsrf(req, session);
      const booking = await this.bookings.addReview(Number(reviewMatch[1]), user.id, await readJson(req));
      json(res, 201, { booking, message: 'Спасибо, отзыв сохранён.' });
      return;
    }
    if (method === 'GET' && pathname === '/api/admin/bookings') {
      await this.requireAdmin(req, res);
      json(res, 200, { bookings: await this.admin.listBookings(searchParams.get('status') || '') });
      return;
    }
    const statusMatch = pathname.match(/^\/api\/admin\/bookings\/(\d+)\/status$/);
    if (method === 'PATCH' && statusMatch) {
      const { session } = await this.requireAdmin(req, res);
      this.requireCsrf(req, session);
      const input = await readJson(req);
      json(res, 200, { booking: await this.admin.updateStatus(Number(statusMatch[1]), String(input.status || '')), message: 'Статус обновлён.' });
      return;
    }
    throw new AppError(404, 'API-маршрут не найден.');
  }

  serveStatic(res, pathname) {
    const pageRoutes = ['/', '/login', '/register', '/dashboard', '/bookings/new', '/admin'];
    if (pageRoutes.includes(pathname)) {
      const body = readFileSync(resolve(publicRoot, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-cache' });
      res.end(body);
      return;
    }
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      throw new AppError(400, 'Некорректный адрес.');
    }
    const assetPath = resolve(publicRoot, `.${decoded}`);
    if (!assetPath.startsWith(`${publicRoot}${sep}`) || !existsSync(assetPath)) throw new AppError(404, 'Страница не найдена.');
    const body = readFileSync(assetPath);
    res.writeHead(200, {
      'Content-Type': mimeTypes[extname(assetPath)] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  }
}

export async function startApplication(options = {}) {
  const includeDemoAdmin = options.includeDemoAdmin ?? (process.env.NODE_ENV !== 'production' && process.env.SEED_DEMO_ADMIN !== 'false');
  const secureCookie = options.secureCookie ?? process.env.COOKIE_SECURE === 'true';
  const app = await ConferenceApplication.create({
    databaseUrl: options.databaseUrl, schema: options.schema, includeDemoAdmin, secureCookie,
  });
  try {
    const address = await app.listen({
      port: options.port ?? Number(process.env.PORT || 3000),
      host: options.host || process.env.HOST || '127.0.0.1',
    });
    return { app, address };
  } catch (error) {
    await app.close();
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { address } = await startApplication();
  console.log(`Конференции.РФ запущены: http://${address.address}:${address.port}`);
}
