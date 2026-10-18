``` md
**Учебная практика осень 26**
```
``` md
> Запуск проекта
```
``` md
### 1. ...% Node.js 22+ и PostgreSQL 17
```
``` md
### 2. Создать юзера и бд
```
```sql
CREATE USER user123 WITH PASSWORD 'PASSWORD';
CREATE DATABASE conference_rf OWNER user123;
```
``` md
### 3. Создать .env
```
```env
DATABASE_URL=postgresql://user123:PASSWORD@127.0.0.1:5433/conference_rf
PORT=3000
HOST=127.0.0.1
SEED_DEMO_ADMIN=true
```
``` md
### 4. Установить зависимости
```
```bash
npm install
```
``` md
### 5. Создать таблицы и заполнить базу
```
```bash
npm run db:migrate
npm run db:seed
```
``` md
### 6. Запустить
```
```bash
npm start
```
``` md
### 7. Ссылка
```
``` bash
http://127.0.0.1:3000
```