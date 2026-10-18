const main = document.querySelector('#content');
const nav = document.querySelector('#navigation');
const notice = document.querySelector('#notice');
const state = { user: null, csrf: '' };

const safe = (text = '') => String(text).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

async function api(url, method = 'GET', data) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    let response;
    try {
      response = await fetch(url, {
        method,
        credentials: 'same-origin',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(data !== undefined ? { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf } : {}),
        },
        ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
      });
    } catch (error) {
      if (controller.signal.aborted) throw new Error('Сервер не ответил за 8 секунд. Проверьте PostgreSQL и /api/health.');
      throw new Error('Не удалось связаться с сервером. Проверьте соединение и работу Node.js.');
    }
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error(`Некорректный ответ от ${url} (HTTP ${response.status}).`);
    }
    if (result.csrfToken) state.csrf = result.csrfToken;
    if (!response.ok) {
      const error = new Error(result.message || `Ошибка HTTP ${response.status}`);
      error.fields = result.errors || {};
      throw error;
    }
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

function flash(message, error = false) {
  notice.textContent = message;
  notice.classList.toggle('error', error);
  notice.hidden = false;
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => { notice.hidden = true; }, 3500);
}

function show(title, html) {
  document.title = `${title} — Конференции.РФ`;
  main.innerHTML = `<section class="page"><h1>${safe(title)}</h1>${html}</section>`;
}

function link(href, label, active = false) {
  return `<a href="${href}"${active ? ' aria-current="page"' : ''}>${label}</a>`;
}

function renderNav() {
  const links = [['/', 'Помещения']];
  if (state.user) {
    links.push(['/bookings/new', 'Новая заявка'], ['/dashboard', 'Мои заявки']);
    if (state.user.role === 'admin') links.push(['/admin', 'Администратор']);
  } else links.push(['/login', 'Вход'], ['/register', 'Регистрация']);
  nav.innerHTML = links.map(([href, name]) => link(href, name, location.pathname === href)).join('') +
    (state.user ? '<button class="logout" type="button">Выйти</button>' : '');
  nav.querySelector('.logout')?.addEventListener('click', async () => {
    try {
      await api('/api/auth/logout', 'POST', {});
      location.href = '/login';
    } catch (error) { flash(error.message, true); }
  });
}

function formField(name, label, attributes = '', hint = '') {
  return `<label class="field">${label}<input name="${name}" ${attributes} required>${hint ? `<small>${hint}</small>` : ''}<span class="field-error" data-for="${name}"></span></label>`;
}

function onForm(form, url, success, method = 'POST') {
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    form.querySelectorAll('.field-error').forEach(element => { element.textContent = ''; });
    form.querySelector('.form-error')?.remove();
    try {
      const result = await api(url, method, Object.fromEntries(new FormData(form)));
      await success(result);
    } catch (error) {
      const message = document.createElement('p');
      message.className = 'form-error';
      message.setAttribute('role', 'alert');
      message.textContent = error.message;
      form.prepend(message);
      for (const [name, text] of Object.entries(error.fields || {})) {
        const field = form.querySelector(`[data-for="${CSS.escape(name)}"]`);
        if (field) field.textContent = text;
      }
      button.disabled = false;
    }
  });
}

function requireUser(admin = false) {
  if (!state.user) {
    show('Требуется вход', `<p>Для продолжения войдите в систему.</p>${link('/login', 'Войти')}`);
    return false;
  }
  if (admin && state.user.role !== 'admin') {
    show('Нет доступа', `<p>Этот раздел доступен администратору.</p>${link('/', 'На главную')}`);
    return false;
  }
  return true;
}

async function home() {
  const { rooms } = await api('/api/rooms');
  show('Конференции без лишних шагов', `
    <p class="intro">Выберите помещение, укажите дату и отправьте заявку.</p>
    <a class="button" href="${state.user ? '/bookings/new' : '/register'}">${state.user ? 'Создать заявку' : 'Забронировать помещение'}</a>
    <h2 class="section-title">Доступные помещения</h2>
    <div class="rooms">${rooms.map(room => `
      <article class="room">
        <div><span class="muted small">${safe(room.type)}</span><h3>${safe(room.name)}</h3><p>${safe(room.description)}</p></div>
      </article>`).join('')}</div>`);
}

function login() {
  if (state.user) { location.replace('/dashboard'); return; }
  show('Вход', `<form class="form" id="auth-form" novalidate>
    ${formField('login', 'Логин', 'autocomplete="username"')}
    ${formField('password', 'Пароль', 'type="password" autocomplete="current-password"')}
    <button class="button" type="submit">Войти</button>
    <p class="muted small">Нет аккаунта? ${link('/register', 'Зарегистрироваться')}</p>
  </form>`);
  onForm(document.querySelector('#auth-form'), '/api/auth/login', result => {
    location.href = result.user.role === 'admin' ? '/admin' : '/dashboard';
  });
}

function register() {
  if (state.user) { location.replace('/dashboard'); return; }
  show('Регистрация', `<form class="form" id="auth-form" novalidate>
    ${formField('login', 'Логин', 'autocomplete="username"', 'Латиница и цифры, от 6 символов')}
    ${formField('password', 'Пароль', 'type="password" autocomplete="new-password"', 'От 8 символов')}
    ${formField('fullName', 'ФИО', 'autocomplete="name"')}
    ${formField('phone', 'Телефон', 'type="tel" placeholder="8(999)123-45-67" autocomplete="tel"')}
    ${formField('email', 'Email', 'type="email" autocomplete="email"')}
    <button class="button" type="submit">Создать аккаунт</button>
    <p class="muted small">Уже есть аккаунт? ${link('/login', 'Войти')}</p>
  </form>`);
  onForm(document.querySelector('#auth-form'), '/api/auth/register', () => { location.href = '/bookings/new'; });
}

async function newBooking() {
  if (!requireUser()) return;
  const { rooms } = await api('/api/rooms');
  const future = new Date(Date.now() + 60 * 60 * 1000);
  const min = new Date(future.getTime() - future.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  show('Новая заявка', `<form class="form" id="booking-form" novalidate>
    <label class="field">Помещение<select name="roomId" required>
      <option value="">Выберите помещение</option>
      ${rooms.map(r => `<option value="${r.id}">${safe(r.name)}</option>`).join('')}
    </select><span class="field-error" data-for="roomId"></span></label>
    ${formField('startAt', 'Дата и время', `type="datetime-local" min="${min}"`)}
    <fieldset><legend>Способ оплаты</legend>
      <label class="choice"><input type="radio" name="paymentMethod" value="При очном посещении" checked> При очном посещении</label>
      <label class="choice"><input type="radio" name="paymentMethod" value="СБП"> СБП</label>
      <span class="field-error" data-for="paymentMethod"></span>
    </fieldset>
    <button class="button" type="submit">Отправить заявку</button>
  </form>`);
  onForm(document.querySelector('#booking-form'), '/api/bookings', () => { location.href = '/dashboard'; });
}

function statusLabel(status) {
  const type = status === 'Завершено' ? 'done' : status === 'Мероприятие назначено' ? 'scheduled' : '';
  return `<span class="status ${type}">${safe(status)}</span>`;
}

function date(value) {
  return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function bookingCard(booking, admin = false) {
  const info = `<p class="muted small">${date(booking.startAt)} · ${safe(booking.paymentMethod)}</p>`;
  const details = admin
    ? `<p class="small">${safe(booking.fullName)} · ${safe(booking.phone)} · ${safe(booking.email)}</p>`
    : `<p class="small muted">${safe(booking.roomType)}</p>`;
  let actions = '';
  if (admin) {
    actions = booking.status === 'Завершено' ? '' : `<div class="actions">
      ${booking.status === 'Новая' ? '<button class="button outline" type="button" data-status="Мероприятие назначено">Назначить</button>' : ''}
      <button class="button outline" type="button" data-status="Завершено">Завершить</button>
    </div>`;
  } else if (booking.reviewText) {
    actions = `<p class="review"><strong>Отзыв:</strong> ${safe(booking.reviewText)}</p>`;
  } else if (booking.status === 'Завершено') {
    actions = `<form class="review-form" data-id="${booking.id}" novalidate>
      <label class="field">Ваш отзыв<textarea name="text" minlength="10" maxlength="1000" required></textarea>
      <span class="field-error" data-for="text"></span></label>
      <button class="button outline" type="submit">Сохранить отзыв</button>
    </form>`;
  }
  return `<article class="booking" data-id="${booking.id}">
    <div class="booking-head"><h3>${safe(booking.roomName)}</h3>${statusLabel(booking.status)}</div>
    ${info}${details}${actions}
  </article>`;
}

async function dashboard() {
  if (!requireUser()) return;
  const { bookings } = await api('/api/bookings/my');
  show('Мои заявки', `<div class="toolbar"><span class="muted">Всего: ${bookings.length}</span>
    <a class="button" href="/bookings/new">Новая заявка</a></div>
    ${bookings.length ? `<div class="bookings">${bookings.map(b => bookingCard(b)).join('')}</div>` : '<p>Заявок пока нет.</p>'}`);
  document.querySelectorAll('.review-form').forEach(form => {
    onForm(form, `/api/bookings/${form.dataset.id}/reviews`, async () => {
      flash('Отзыв сохранён');
      await dashboard();
    });
  });
}

async function admin(status = '') {
  if (!requireUser(true)) return;
  const query = status ? `?status=${encodeURIComponent(status)}` : '';
  const { bookings } = await api(`/api/admin/bookings${query}`);
  show('Заявки участников', `<div class="toolbar">
    <label class="filter">Статус<select id="filter">
      ${['', 'Новая', 'Мероприятие назначено', 'Завершено'].map(s =>
        `<option value="${safe(s)}"${s === status ? ' selected' : ''}>${s || 'Все'}</option>`).join('')}
    </select></label><span class="muted">Найдено: ${bookings.length}</span></div>
    ${bookings.length ? `<div class="bookings">${bookings.map(b => bookingCard(b, true)).join('')}</div>` : '<p>Заявок нет.</p>'}`);
  document.querySelector('#filter').addEventListener('change', event => admin(event.target.value));
  document.querySelectorAll('[data-status]').forEach(button => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      const id = button.closest('.booking').dataset.id;
      try {
        await api(`/api/admin/bookings/${id}/status`, 'PATCH', { status: button.dataset.status });
        await admin(status);
        flash('Статус изменён');
      } catch (error) { flash(error.message, true); button.disabled = false; }
    });
  });
}

async function start() {
  try {
    const menuButton = document.querySelector('#menu-button');
    menuButton?.addEventListener('click', event => {
      const opened = nav.classList.toggle('open');
      event.currentTarget.setAttribute('aria-expanded', String(opened));
    });

    renderNav();
    const session = await api('/api/auth/me');
    state.user = session.user;
    renderNav();
    const routes = { '/': home, '/login': login, '/register': register,
      '/bookings/new': newBooking, '/dashboard': dashboard, '/admin': admin };
    const route = routes[location.pathname];
    if (route) await route();
    else show('Страница не найдена', link('/', 'На главную'));
  } catch (error) {
    console.error('Ошибка инициализации сайта:', error);
    show('Не удалось загрузить сайт', `<p>${safe(error.message)}</p>
      <p>Проверьте <a href="/api/health">состояние сервера и базы данных</a>, затем обновите страницу.</p>
      <a href="/" class="button">Повторить</a>`);
  }
}

start();
