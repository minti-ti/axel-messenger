/**
 * Точка входа /api/chats/*.
 *
 * Исторически весь функционал жил в одном файле на 1442 строки. Теперь он
 * разнесён по модулям в src/routes/chats/ и собирается здесь:
 *
 *   _helpers.js  — общая инфраструктура (multer, rate-limit, permissions...)
 *   messages.js  — отправка/чтение/реакции/форварды/удаление/комменты/scheduled/pin/media/search
 *   members.js   — участники, роли, mute/ban
 *   invites.js   — инвайт-ссылки, публичные чаты (/public/, /join/)
 *   core.js      — CRUD чатов, drafts, preferences, avatar, /saved, /username
 *
 * ВАЖНО про порядок:
 *   - authMiddleware применяется глобально через router.use(authMiddleware)
 *     один раз — все подмаршруты унаследуют его.
 *   - router.param('chatId'|'messageId') тоже регистрируется здесь, чтобы
 *     валидация UUID работала во всех подмаршрутах автоматически.
 *   - Подроутеры подключаются в порядке «специфичные раньше общих»:
 *     messages (там и /search/messages, и /messages/*) → members (/.../members*) →
 *     invites (/join/*, /public/*, /:chatId/invites*) → core (/, /:chatId,
 *     /saved, /username/*, drafts, preferences, avatar).
 *     core должен идти ПОСЛЕДНИМ, т.к. содержит маршрут `GET /:chatId`,
 *     который может «съесть» более специфичные пути вроде `/saved`,
 *     если они окажутся ниже.
 *     На самом деле Express матчит маршруты в порядке регистрации, поэтому
 *     внутри core.js `/saved` идёт ДО `/:chatId` — это гарантирует корректность.
 */

const express = require('express');
const { authMiddleware } = require('../auth');
const { isValidUUID } = require('../validators');

const messagesRouter = require('./chats/messages');
const membersRouter = require('./chats/members');
const invitesRouter = require('./chats/invites');
const coreRouter = require('./chats/core');

const router = express.Router();

// Глобально для всех /api/chats/* — требуем валидный JWT.
router.use(authMiddleware);

// Валидация UUID-параметров на уровне роутера. Делается ОДИН раз тут,
// чтобы во всех подмаршрутах автоматически работало.
router.param('chatId', (req, res, next, val) => {
  if (!isValidUUID(val)) return res.status(400).json({ error: 'Некорректный идентификатор чата' });
  next();
});
router.param('messageId', (req, res, next, val) => {
  if (!isValidUUID(val)) return res.status(400).json({ error: 'Некорректный идентификатор сообщения' });
  next();
});

// Подключаем подроутеры. Порядок важен: messages и invites имеют свои
// специфичные пути под /messages/*, /join/*, /public/* — их нужно матчить
// раньше «общих» путей вроде /:chatId из core.
router.use(messagesRouter);
router.use(membersRouter);
router.use(invitesRouter);
router.use(coreRouter);

module.exports = router;
