import { hashPassword, verifyPassword } from './security.js';
import { hasErrors, validateBooking, validateLogin, validateRegistration, validateReview } from './validation.js';

export class AppError extends Error {
  constructor(status, message, errors = undefined) {
    super(message);
    this.status = status;
    this.errors = errors;
  }
}

const first = async (db, sql, params = []) => (await db.query(sql, params)).rows[0] ?? null;

export class AuthService {
  constructor(db) { this.db = db; }

  async register(input) {
    const { errors, value } = validateRegistration(input);
    if (hasErrors(errors)) throw new AppError(422, 'Проверьте поля формы.', errors);
    if (await first(this.db, 'SELECT 1 FROM users WHERE lower(login) = lower($1)', [value.login])) {
      errors.login = 'Этот логин уже занят.';
    }
    if (await first(this.db, 'SELECT 1 FROM users WHERE lower(email) = lower($1)', [value.email])) {
      errors.email = 'Этот адрес электронной почты уже используется.';
    }
    if (hasErrors(errors)) throw new AppError(409, 'Пользователь с такими данными уже существует.', errors);
    let user;
    try {
      user = await first(this.db, `INSERT INTO users (login, password_hash, full_name, phone, email)
        VALUES ($1, $2, $3, $4, $5) RETURNING *`, [
        value.login, hashPassword(value.password), value.fullName, value.phone, value.email,
      ]);
    } catch (error) {
      if (error.code === '23505') {
        if (error.constraint?.includes('login')) errors.login = 'Этот логин уже занят.';
        if (error.constraint?.includes('email')) errors.email = 'Этот адрес электронной почты уже используется.';
        throw new AppError(409, 'Пользователь с такими данными уже существует.', errors);
      }
      throw error;
    }
    return this.publicUser(user);
  }

  async login(input) {
    const { errors, value } = validateLogin(input);
    if (hasErrors(errors)) throw new AppError(422, 'Проверьте поля формы.', errors);
    const user = await first(this.db, 'SELECT * FROM users WHERE lower(login) = lower($1)', [value.login]);
    if (!user || !verifyPassword(value.password, user.password_hash)) throw new AppError(401, 'Неверный логин или пароль.');
    return this.publicUser(user);
  }

  publicUser(user) {
    return user ? {
      id: user.id, login: user.login, fullName: user.full_name,
      phone: user.phone, email: user.email, role: user.role,
    } : null;
  }
}

const bookingFields = `b.id, b.start_at AS "startAt", b.payment_method AS "paymentMethod",
  b.status, b.created_at AS "createdAt", r.name AS "roomName", r.type AS "roomType",
  rv.text AS "reviewText", rv.created_at AS "reviewCreatedAt"`;
const bookingJoins = `FROM bookings b JOIN rooms r ON r.id = b.room_id
  LEFT JOIN reviews rv ON rv.booking_id = b.id`;

export class BookingService {
  constructor(db) { this.db = db; }

  async listRooms() {
    return (await this.db.query(`SELECT id, name, type, capacity, description
      FROM rooms WHERE is_active = TRUE ORDER BY id`)).rows;
  }

  async create(userId, input) {
    const { errors, value } = validateBooking(input);
    if (hasErrors(errors)) throw new AppError(422, 'Проверьте поля формы.', errors);
    if (!await first(this.db, 'SELECT 1 FROM rooms WHERE id = $1 AND is_active = TRUE', [value.roomId])) {
      throw new AppError(422, 'Выбранное помещение недоступно.', { roomId: 'Выбранное помещение недоступно.' });
    }
    const created = await first(this.db, `INSERT INTO bookings (user_id, room_id, start_at, payment_method)
      VALUES ($1, $2, $3, $4) RETURNING id`, [userId, value.roomId, value.startAt, value.paymentMethod]);
    return this.getOwned(created.id, userId);
  }

  async getOwned(bookingId, userId) {
    return first(this.db, `SELECT ${bookingFields} ${bookingJoins}
      WHERE b.id = $1 AND b.user_id = $2`, [bookingId, userId]);
  }

  async listMine(userId) {
    return (await this.db.query(`SELECT ${bookingFields} ${bookingJoins}
      WHERE b.user_id = $1 ORDER BY b.created_at DESC, b.id DESC`, [userId])).rows;
  }

  async addReview(bookingId, userId, input) {
    const { errors, value } = validateReview(input);
    if (hasErrors(errors)) throw new AppError(422, 'Проверьте отзыв.', errors);
    const booking = await first(this.db, 'SELECT id, status FROM bookings WHERE id = $1 AND user_id = $2', [bookingId, userId]);
    if (!booking) throw new AppError(404, 'Заявка не найдена.');
    if (booking.status !== 'Завершено') throw new AppError(409, 'Отзыв доступен только после завершения мероприятия.');
    try {
      await this.db.query('INSERT INTO reviews (booking_id, user_id, text) VALUES ($1, $2, $3)', [bookingId, userId, value.text]);
    } catch (error) {
      if (error.code === '23505' && error.constraint?.includes('booking_id')) {
        throw new AppError(409, 'Отзыв по этой заявке уже оставлен.');
      }
      throw error;
    }
    return this.getOwned(bookingId, userId);
  }
}

export class AdminService {
  constructor(db) { this.db = db; }

  async listBookings(status = '') {
    const allowed = ['', 'Новая', 'Мероприятие назначено', 'Завершено'];
    if (!allowed.includes(status)) throw new AppError(400, 'Неизвестный фильтр статуса.');
    const where = status ? 'WHERE b.status = $1' : '';
    return (await this.db.query(`SELECT b.id, b.start_at AS "startAt", b.payment_method AS "paymentMethod",
      b.status, b.created_at AS "createdAt", r.name AS "roomName", r.type AS "roomType",
      u.login, u.full_name AS "fullName", u.phone, u.email, rv.text AS "reviewText"
      FROM bookings b JOIN rooms r ON r.id = b.room_id JOIN users u ON u.id = b.user_id
      LEFT JOIN reviews rv ON rv.booking_id = b.id ${where}
      ORDER BY b.created_at DESC, b.id DESC`, status ? [status] : [])).rows;
  }

  async updateStatus(bookingId, nextStatus) {
    if (!['Мероприятие назначено', 'Завершено'].includes(nextStatus)) {
      throw new AppError(422, 'Недопустимый статус.', { status: 'Выберите допустимый статус.' });
    }
    const booking = await first(this.db, 'SELECT id, status FROM bookings WHERE id = $1', [bookingId]);
    if (!booking) throw new AppError(404, 'Заявка не найдена.');
    const transitions = {
      'Новая': ['Мероприятие назначено', 'Завершено'],
      'Мероприятие назначено': ['Завершено'],
      'Завершено': [],
    };
    if (!transitions[booking.status].includes(nextStatus)) {
      throw new AppError(409, `Переход из статуса «${booking.status}» в «${nextStatus}» запрещён.`);
    }
    const changed = await first(this.db, `UPDATE bookings SET status = $1
      WHERE id = $2 AND status = $3 RETURNING id`, [nextStatus, bookingId, booking.status]);
    if (!changed) throw new AppError(409, 'Статус изменился. Обновите страницу.');
    const rows = await this.listBookings();
    return rows.find((item) => item.id === bookingId);
  }
}
