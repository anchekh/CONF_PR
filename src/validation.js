const LOGIN_RE = /^[A-Za-z0-9]{6,}$/;
const NAME_RE = /^[А-Яа-яЁё]+(?: [А-Яа-яЁё]+)*$/u;
const PHONE_RE = /^8\(\d{3}\)\d{3}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validateRegistration(input) {
  const errors = {};
  const login = String(input.login || '').trim();
  const password = String(input.password || '');
  const fullName = String(input.fullName || '').trim().replace(/\s+/g, ' ');
  const phone = String(input.phone || '').trim();
  const email = String(input.email || '').trim().toLowerCase();

  if (!LOGIN_RE.test(login)) errors.login = 'Логин: только латинские буквы и цифры, не менее 6 символов.';
  if (password.length < 8) errors.password = 'Пароль должен содержать не менее 8 символов.';
  if (!NAME_RE.test(fullName)) errors.fullName = 'ФИО должно содержать только кириллические буквы и пробелы.';
  if (!PHONE_RE.test(phone)) errors.phone = 'Используйте формат 8(XXX)XXX-XX-XX.';
  if (!EMAIL_RE.test(email)) errors.email = 'Введите корректный адрес электронной почты.';

  return { errors, value: { login, password, fullName, phone, email } };
}

export function validateLogin(input) {
  const login = String(input.login || '').trim();
  const password = String(input.password || '');
  const errors = {};
  if (!login) errors.login = 'Введите логин.';
  if (!password) errors.password = 'Введите пароль.';
  return { errors, value: { login, password } };
}

export function validateBooking(input) {
  const roomId = Number(input.roomId);
  const startAt = String(input.startAt || '');
  const paymentMethod = String(input.paymentMethod || '');
  const errors = {};

  if (!Number.isInteger(roomId) || roomId <= 0) errors.roomId = 'Выберите помещение.';
  const parsedDate = new Date(startAt);
  if (!startAt || Number.isNaN(parsedDate.getTime())) {
    errors.startAt = 'Укажите корректные дату и время.';
  } else if (parsedDate.getTime() <= Date.now()) {
    errors.startAt = 'Дата начала должна быть в будущем.';
  }
  if (!['При очном посещении', 'СБП'].includes(paymentMethod)) {
    errors.paymentMethod = 'Выберите способ оплаты.';
  }
  return { errors, value: { roomId, startAt: Number.isNaN(parsedDate.getTime()) ? null : parsedDate.toISOString(), paymentMethod } };
}

export function validateReview(input) {
  const text = String(input.text || '').trim();
  const errors = {};
  if (text.length < 10 || text.length > 1000) errors.text = 'Отзыв должен содержать от 10 до 1000 символов.';
  return { errors, value: { text } };
}

export function hasErrors(errors) {
  return Object.keys(errors).length > 0;
}
