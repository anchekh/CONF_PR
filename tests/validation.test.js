import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateBooking, validateRegistration, validateReview } from '../src/validation.js';

test('регистрация принимает корректные данные', () => {
  const { errors, value } = validateRegistration({
    login: 'Demo2027', password: 'Secret123', fullName: 'Иванов Иван',
    phone: '8(999)123-45-67', email: 'TEST@example.com',
  });
  assert.deepEqual(errors, {});
  assert.equal(value.email, 'test@example.com');
});

test('регистрация отклоняет неверные поля', () => {
  const { errors } = validateRegistration({
    login: 'abc', password: '123', fullName: 'John Doe', phone: '123', email: 'wrong',
  });
  assert.deepEqual(Object.keys(errors).sort(), ['email', 'fullName', 'login', 'password', 'phone']);
});

test('заявка не принимает неверный способ оплаты', () => {
  const { errors } = validateBooking({
    roomId: 1, startAt: '2035-01-01T12:00:00.000Z', paymentMethod: 'Наличные',
  });
  assert.ok(errors.paymentMethod);
});

test('отзыв требует минимум 10 символов', () => {
  assert.ok(validateReview({ text: 'ОК' }).errors.text);
  assert.deepEqual(validateReview({ text: 'Отличный зал и организация' }).errors, {});
});

test('интерфейс не отображает вместимость помещений', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /capacity/i);
  assert.doesNotMatch(styles, /capacity/i);
});
