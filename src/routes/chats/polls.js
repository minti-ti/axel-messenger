'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../../db');
const { getChatPermission } = require('./_helpers');
const { formatMessage } = require('../../chatService');
const log = require('../../logger');

const router = express.Router();

// POST /:chatId/polls — создать опрос
router.post('/:chatId/polls', async (req, res) => {
  try {
    const { chatId } = req.params;
    const permission = await getChatPermission(chatId, req.user.id);
    if (!permission) return res.status(403).json({ error: 'Нет доступа к чату' });

    const question = String(req.body.question || '').trim();
    const options = Array.isArray(req.body.options) ? req.body.options.map(o => String(o).trim()).filter(Boolean) : [];
    const isAnonymous = req.body.isAnonymous !== false;
    const isMultiple = Boolean(req.body.isMultiple);

    if (!question || question.length > 300) return res.status(400).json({ error: 'Вопрос обязателен (макс. 300 символов)' });
    if (options.length < 2 || options.length > 10) return res.status(400).json({ error: 'Нужно от 2 до 10 вариантов' });

    const pollId = uuidv4();
    const messageId = uuidv4();

    // Создаём сообщение с типом 'poll'
    await query(
      `INSERT INTO messages (id, chat_id, user_id, content, message_type) VALUES ($1, $2, $3, $4, $5)`,
      [messageId, chatId, req.user.id, `📊 ${question}`, 'poll']
    );

    await query(
      `INSERT INTO polls (id, chat_id, message_id, creator_id, question, is_anonymous, is_multiple) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [pollId, chatId, messageId, req.user.id, question, isAnonymous, isMultiple]
    );

    for (let i = 0; i < options.length; i++) {
      await query(
        `INSERT INTO poll_options (id, poll_id, option_text, position) VALUES ($1, $2, $3, $4)`,
        [uuidv4(), pollId, options[i], i]
      );
    }

    const message = await formatMessage(messageId);
    // Добавим poll data к сообщению
    const pollData = await getPollData(pollId, req.user.id);
    message.poll = pollData;

    req.app.get('io').to(chatId).emit('message:new', message);
    log.info({ chatId, pollId }, 'poll created');

    res.status(201).json({ message, poll: pollData });
  } catch (error) {
    log.error({ err: error }, 'failed to create poll');
    res.status(500).json({ error: 'Не удалось создать опрос' });
  }
});

// POST /polls/:pollId/vote — проголосовать
router.post('/polls/:pollId/vote', async (req, res) => {
  try {
    const { pollId } = req.params;
    const optionIds = Array.isArray(req.body.optionIds) ? req.body.optionIds : [req.body.optionId].filter(Boolean);

    const poll = await query('SELECT * FROM polls WHERE id = $1', [pollId]);
    if (!poll.rows[0]) return res.status(404).json({ error: 'Опрос не найден' });
    if (poll.rows[0].is_closed) return res.status(400).json({ error: 'Опрос закрыт' });

    const permission = await getChatPermission(poll.rows[0].chat_id, req.user.id);
    if (!permission) return res.status(403).json({ error: 'Нет доступа к чату' });

    if (!poll.rows[0].is_multiple && optionIds.length > 1) {
      return res.status(400).json({ error: 'В этом опросе можно выбрать только один вариант' });
    }

    // Удаляем предыдущие голоса (для single-choice переголосовать)
    if (!poll.rows[0].is_multiple) {
      await query('DELETE FROM poll_votes WHERE poll_id = $1 AND user_id = $2', [pollId, req.user.id]);
    }

    for (const optionId of optionIds) {
      const voteId = uuidv4();
      await query(
        `INSERT INTO poll_votes (id, poll_id, option_id, user_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [voteId, pollId, optionId, req.user.id]
      );
    }

    const pollData = await getPollData(pollId, req.user.id);

    // Эмитим обновление опроса всем в чате
    req.app.get('io').to(poll.rows[0].chat_id).emit('poll:update', {
      pollId,
      messageId: poll.rows[0].message_id,
      poll: pollData
    });

    res.json({ poll: pollData });
  } catch (error) {
    log.error({ err: error }, 'failed to vote');
    res.status(500).json({ error: 'Не удалось проголосовать' });
  }
});

// GET /polls/:pollId — данные опроса
router.get('/polls/:pollId', async (req, res) => {
  try {
    const pollData = await getPollData(req.params.pollId, req.user.id);
    if (!pollData) return res.status(404).json({ error: 'Опрос не найден' });
    res.json({ poll: pollData });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка загрузки опроса' });
  }
});

// POST /polls/:pollId/close — закрыть опрос (только создатель)
router.post('/polls/:pollId/close', async (req, res) => {
  try {
    const poll = await query('SELECT * FROM polls WHERE id = $1', [req.params.pollId]);
    if (!poll.rows[0]) return res.status(404).json({ error: 'Опрос не найден' });
    if (poll.rows[0].creator_id !== req.user.id) return res.status(403).json({ error: 'Только создатель может закрыть опрос' });
    await query('UPDATE polls SET is_closed = TRUE WHERE id = $1', [req.params.pollId]);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

async function getPollData(pollId, viewerId) {
  const poll = await query('SELECT * FROM polls WHERE id = $1', [pollId]);
  if (!poll.rows[0]) return null;
  const p = poll.rows[0];

  const options = await query(
    'SELECT po.*, COUNT(pv.id)::int AS votes FROM poll_options po LEFT JOIN poll_votes pv ON pv.option_id = po.id GROUP BY po.id ORDER BY po.position',
    []
  );
  // Фильтруем по poll_id в JS (проще чем параметризированный GROUP BY)
  const pollOptions = options.rows.filter(o => o.poll_id === pollId);

  const myVotes = await query('SELECT option_id FROM poll_votes WHERE poll_id = $1 AND user_id = $2', [pollId, viewerId]);
  const myOptionIds = myVotes.rows.map(v => v.option_id);

  const totalVotes = pollOptions.reduce((sum, o) => sum + o.votes, 0);

  return {
    id: p.id,
    question: p.question,
    isAnonymous: p.is_anonymous,
    isMultiple: p.is_multiple,
    isClosed: p.is_closed,
    creatorId: p.creator_id,
    totalVotes,
    options: pollOptions.map(o => ({
      id: o.id,
      text: o.option_text,
      votes: o.votes,
      percentage: totalVotes > 0 ? Math.round(o.votes / totalVotes * 100) : 0,
      voted: myOptionIds.includes(o.id)
    })),
    myVotes: myOptionIds
  };
}

module.exports = router;
