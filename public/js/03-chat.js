/**
 * Axel Messenger — фронтенд, часть 03: Открытие чатов, действия с сообщениями, профили, настройки.
 *
 * До рефакторинга весь клиент жил в одном public/js/app.js на 4134 строки.
 * Теперь он разрезан на 4 файла, которые подключаются строго по порядку
 * (см. <script src='/js/0X-...js'> в public/index.html).
 *
 * Содержит: render*-функции для чатов и сообщений, openChat, openModal*-обёртки (профили, настройки, модерация, sessions, restrictions), submitComposer и связанная логика. Зависит от state.js и ui-utils.js.
 *
 * ВАЖНО: модуль грузится как обычный <script>, без import/export. Все
 * объявленные тут переменные и функции остаются глобальными — так же,
 * как было в монолите. Это сознательное решение, чтобы рефакторинг
 * был safe-by-default (не меняет ни одной строки логики).
 */

function openDrawer() {
  state.drawerOpen = true;
  el.leftDrawer.classList.remove('hidden');
  el.drawerOverlay.classList.remove('hidden');
  requestAnimationFrame(() => el.leftDrawer.classList.add('open'));
}

function closeDrawer(immediate = false) {
  state.drawerOpen = false;
  el.leftDrawer.classList.remove('open');
  if (immediate) {
    el.leftDrawer.classList.add('hidden');
    el.drawerOverlay.classList.add('hidden');
    return;
  }
  setTimeout(() => {
    if (!state.drawerOpen) {
      el.leftDrawer.classList.add('hidden');
      el.drawerOverlay.classList.add('hidden');
    }
  }, 220);
}

function openModal(title, html, onSubmit, options = {}) {
  const card = el.modal.querySelector('.modal-card');
  card.classList.remove('editor-modal');
  if (options.cardClass) card.classList.add(options.cardClass);
  el.modalTitle.textContent = title;
  el.modalBody.innerHTML = html;
  el.modal.classList.remove('hidden');
  const form = el.modalBody.querySelector('form');
  if (form && onSubmit) {
    form.onsubmit = async (event) => {
      event.preventDefault();
      try {
        await onSubmit(new FormData(form), form);
      } catch (error) {
        showToast(error.message, true);
      }
    };
  }
}

function openEditorModal(title, html, onSubmit) {
  openModal(title, html, onSubmit, { cardClass: 'editor-modal' });
}

function closeModal() {
  const card = el.modal.querySelector('.modal-card');
  card.classList.remove('editor-modal');
  el.modal.classList.add('hidden');
  el.modalBody.innerHTML = '';
}

async function loadSettings() {
  try {
    const { settings } = await api('/api/users/me/settings');
    state.settings = settings;
  } catch (error) {
    console.warn('Cannot load settings', error);
  }
  applySettings();
}

function renderSidebarProfile() {
  if (!state.user) return;
  el.profileSummary.textContent = [state.user.displayName, state.user.username ? `@${state.user.username}` : state.user.phone].join(' · ');
  el.drawerDisplayName.textContent = state.user.displayName;
  el.drawerPhone.textContent = state.user.phone;
  el.drawerUsername.textContent = state.user.username ? `@${state.user.username}` : 'Без username';
  el.drawerAvatar.innerHTML = state.user.avatarUrl
    ? `<img src="${escapeHtml(state.user.avatarUrl)}" alt="${escapeHtml(state.user.displayName)}" />`
    : escapeHtml(getInitials(state.user.displayName));
  el.drawerModerationBtn.classList.toggle('hidden', !state.user.isSuperadmin);
  // Добавляем кнопку админ-панели если её нет
  if (state.user.isSuperadmin && !document.getElementById('drawerAdminBtn')) {
    const adminBtn = document.createElement('button');
    adminBtn.id = 'drawerAdminBtn';
    adminBtn.className = 'drawer-item';
    adminBtn.innerHTML = '<span class="drawer-icon">⚙️</span><span>Админ-панель</span>';
    adminBtn.onclick = () => { closeDrawer(); openAdminPanel(); };
    el.drawerModerationBtn.parentNode.insertBefore(adminBtn, el.drawerModerationBtn.nextSibling);
  }
}

function matchesQuery(chat) {
  const query = state.searchQuery.trim().toLowerCase().replace(/^@+/, '');
  if (!query) return true;
  return [
    chat.title,
    chat.username,
    chat.description,
    chatPreviewText(chat),
    chat.peer?.displayName,
    chat.peer?.username,
    chat.peer?.phone
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .includes(query);
}

function getVisibleChats() {
  return state.chats.filter((chat) => {
    if (!matchesQuery(chat)) return false;
    if (String(state.chatFilter).startsWith('folder:')) {
      const folder = state.chatFolders.find((item) => folderChipId(item.id) === state.chatFilter);
      return folder ? folder.chatIds.includes(chat.id) : false;
    }
    if (state.chatFilter === 'archive') return chat.archived;
    if (chat.archived) return false;
    if (state.chatFilter === 'private') return chat.type === 'private';
    if (state.chatFilter === 'group') return chat.type === 'group';
    if (state.chatFilter === 'channel') return chat.type === 'channel';
    if (state.chatFilter === 'pinned') return chat.pinned;
    if (state.chatFilter === 'unread') return Number(chat.unreadCount || 0) > 0;
    return true;
  });
}

function chatCardInnerMarkup(chat) {
  const preview = chatPreviewText(chat);
  const isDraft = preview.startsWith('Черновик:');
  return `
    ${avatarMarkup(chat.title, chat.avatarUrl || chat.peer?.avatarUrl, 'avatar')}
    <div class="chat-main">
      <div class="chat-row">
        <div class="chat-name-row">
          <div class="chat-name">${escapeHtml(chat.title || 'Без названия')}</div>
          ${chat.pinned ? '<span class="mini-star">📌</span>' : ''}
          ${chat.favorite ? '<span class="mini-star">★</span>' : ''}
        </div>
        <div class="chat-time">${formatChatTime(chat.lastMessage?.createdAt || chat.createdAt)}</div>
      </div>
      <div class="chat-preview ${isDraft ? 'draft-preview' : ''}">${escapeHtml(preview)}</div>
      <div class="chat-secondary">${chat.username ? '@' + escapeHtml(chat.username) : chat.isSaved ? 'Личное облако файлов и заметок' : chat.type === 'private' && chat.peer?.username ? '@' + escapeHtml(chat.peer.username) : chatTypeLabel(chat)}</div>
    </div>
    <div class="chat-side">
      ${Number(chat.unreadCount || 0) ? `<div class="badge">${chat.unreadCount}</div>` : '<div></div>'}
      <button class="chat-menu-btn" title="Действия">⋮</button>
    </div>
  `;
}

function bindChatCardNode(node, chat) {
  node.className = `chat-card ${state.currentChat?.id === chat.id ? 'active' : ''} ${chat.favorite ? 'favorite-chat' : ''}`;
  node.dataset.chatId = chat.id;
  node.innerHTML = chatCardInnerMarkup(chat);
  node.onclick = () => openChat(chat.id).catch((error) => showToast(error.message, true));
  node.querySelector('.chat-menu-btn').onclick = (event) => {
    event.stopPropagation();
    openChatActions(chat);
  };
}

function createChatCard(chat) {
  const node = document.createElement('div');
  bindChatCardNode(node, chat);
  return node;
}

function updateChatListItem(chatId) {
  const node = el.chatList.querySelector(`[data-chat-id="${chatId}"]`);
  if (!node) return;
  const chat = state.chats.find((item) => item.id === chatId);
  if (!chat) return;
  bindChatCardNode(node, chat);
}

function appendSectionTitle(text) {
  const title = document.createElement('div');
  title.className = 'chat-section-title';
  title.textContent = text;
  el.chatList.appendChild(title);
}

function renderChatListSkeleton() {
  el.chatList.innerHTML = `
    <div class="chat-section-title">Чаты</div>
    <div class="chat-list-skeleton">
      <div class="chat-card-skeleton"></div>
      <div class="chat-card-skeleton"></div>
      <div class="chat-card-skeleton"></div>
      <div class="chat-card-skeleton"></div>
    </div>
  `;
}

function renderChats({ preserveScroll = true } = {}) {
  const previousScroll = preserveScroll ? el.chatList.scrollTop : 0;
  const chats = getVisibleChats();
  el.chatList.innerHTML = '';

  const archivedCount = state.chats.filter((chat) => chat.archived).length;
  if (state.chatFilter === 'all' && archivedCount > 0) {
    const archiveNode = document.createElement('div');
    archiveNode.className = 'archive-entry';
    archiveNode.innerHTML = `<div class="archive-icon">🗂</div><div><strong>Архив</strong><div class="muted">${archivedCount} чат(ов)</div></div>`;
    archiveNode.onclick = () => {
      state.chatFilter = 'archive';
      render();
    };
    el.chatList.appendChild(archiveNode);
  }

  if (!chats.length) {
    el.chatList.innerHTML += `<div class="empty-list">${state.chatFilter === 'archive' ? 'Архив пуст.' : state.searchQuery ? 'Ничего не найдено.' : 'Пока нет чатов. Создайте первый.'}</div>`;
    if (preserveScroll) el.chatList.scrollTop = previousScroll;
    return;
  }

  const pinned = chats.filter((chat) => chat.pinned);
  const regular = chats.filter((chat) => !chat.pinned);

  if (state.chatFilter === 'all' && pinned.length) {
    appendSectionTitle('Закреплённые');
    pinned.forEach((chat) => el.chatList.appendChild(createChatCard(chat)));
  }

  if (state.chatFilter === 'all') {
    const users = regular.filter(c => c.type === 'private');
    const groups = regular.filter(c => c.type === 'group');
    const channels = regular.filter(c => c.type === 'channel');

    if (users.length) {
      appendSectionTitle('Пользователи');
      users.forEach(chat => el.chatList.appendChild(createChatCard(chat)));
    }
    if (groups.length) {
      appendSectionTitle('Группы');
      groups.forEach(chat => el.chatList.appendChild(createChatCard(chat)));
    }
    if (channels.length) {
      appendSectionTitle('Каналы');
      channels.forEach(chat => el.chatList.appendChild(createChatCard(chat)));
    }
    return;
  }
  if (state.chatFilter !== 'all') chats.forEach((chat) => el.chatList.appendChild(createChatCard(chat)));
  if (preserveScroll) el.chatList.scrollTop = previousScroll;
}

function renderSearchResults() {
  if (!state.searchQuery.trim() || !state.userSearchResults.length) {
    el.searchResults.classList.add('hidden');
    el.searchResults.innerHTML = '';
    return;
  }

  el.searchResults.classList.remove('hidden');
  el.searchResults.innerHTML = `
    <div class="search-section-title">Пользователи</div>
    ${state.userSearchResults.map((user) => `
      <div class="search-item" data-user-id="${user.id}">
        ${avatarMarkup(user.displayName, user.avatarUrl, 'avatar small')}
        <div class="search-item-main">
          <div><strong>${escapeHtml(user.displayName)}</strong></div>
          <div class="muted">${user.username ? '@' + escapeHtml(user.username) + ' · ' : ''}${escapeHtml(user.phone || '')}</div>
        </div>
      </div>
    `).join('')}
  `;

  el.searchResults.querySelectorAll('[data-user-id]').forEach((node) => {
    node.onclick = () => openUserProfileModal(node.dataset.userId).catch((error) => showToast(error.message, true));
  });
}

function renderChatHeader() {
  if (!state.currentChat) {
    el.chatHeader.querySelector('.chat-title').textContent = 'Выберите чат';
    el.chatMeta.textContent = 'Saved Messages, публичные ссылки и поиск сообщений уже доступны';
    el.chatHeaderAvatar.innerHTML = 'AM';
    el.typingIndicator.textContent = '';
    el.mobileBackBtn.classList.add('hidden');
    el.chatInfoBtn.classList.add('hidden');
    el.chatSearchBtn.classList.add('hidden');
    el.bulkSelectBtn.classList.add('hidden');
    clearSelection();
    el.composer.classList.add('hidden');
    return;
  }

  const title = state.currentChat.title || 'Без названия';
  el.chatHeader.querySelector('.chat-title').textContent = title;
  el.chatHeaderAvatar.innerHTML = state.currentChat.avatarUrl || state.currentChat.peer?.avatarUrl
    ? `<img src="${escapeHtml(state.currentChat.avatarUrl || state.currentChat.peer?.avatarUrl)}" alt="${escapeHtml(title)}" />`
    : escapeHtml(getInitials(title));

  let meta = '';
  if (state.currentChat.isSaved) {
    meta = 'Личное облако файлов и заметок';
  } else if (state.currentChat.type === 'private') {
    meta = `${state.currentChat.peer?.username ? '@' + state.currentChat.peer.username : state.currentChat.peer?.phone || ''}${currentChatOnlineText()}`;
  } else {
    meta = `${chatTypeLabel(state.currentChat)} · ${state.currentChat.memberCount || 0} участника(ов) · Вы: ${roleLabel(state.currentChat.viewerRole, state.currentChat)}`;
    if (state.currentChat.username) meta += ` · @${state.currentChat.username}`;
  }

  if (state.currentChat.type === 'channel' && !['owner', 'admin'].includes(state.currentChat.viewerRole)) {
    meta += ' · Только администраторы могут писать';
    el.composer.classList.add('hidden');
  } else {
    el.composer.classList.remove('hidden');
  }

  el.chatMeta.textContent = meta;
  el.mobileBackBtn.classList.toggle('hidden', !isMobileViewport());
  el.chatInfoBtn.classList.remove('hidden');
  el.chatSearchBtn.classList.remove('hidden');
  el.bulkSelectBtn.classList.remove('hidden');
  renderTyping();
}

function clearSelection() {
  state.selectMode = false;
  state.selectedMessageIds = [];
}

function toggleMessageSelection(messageId) {
  if (state.selectedMessageIds.includes(messageId)) {
    state.selectedMessageIds = state.selectedMessageIds.filter((id) => id !== messageId);
  } else {
    state.selectedMessageIds = [...state.selectedMessageIds, messageId];
  }
  renderSelectionBar();
  requestRenderMessages();
}

async function deleteSelectedMessages() {
  const ids = [...state.selectedMessageIds];
  try {
    const result = await api('/api/chats/messages/delete-bulk', { 
      method: 'POST', 
      body: { messageIds: ids } 
    });
    clearSelection();
    render();
    showToast(`Удалено сообщений: ${result.deletedCount}`);
  } catch (error) {
    console.warn('Bulk delete failed', error);
    showToast('Не удалось удалить сообщения', true);
  }
}

function renderSelectionBar() {
  if (!state.selectMode) {
    el.selectionBar.classList.add('hidden');
    el.selectionBar.innerHTML = '';
    return;
  }
  el.selectionBar.classList.remove('hidden');
  el.selectionBar.innerHTML = `
    <div><strong>Выбрано: ${state.selectedMessageIds.length}</strong></div>
    <div class="inline-actions">
      <button id="forwardSelectedBtn" class="ghost-btn small">Переслать</button>
      <button id="deleteSelectedBtn" class="ghost-btn small danger-btn">Удалить выбранные</button>
      <button id="cancelSelectionBtn" class="ghost-btn small">Отмена</button>
    </div>
  `;
  document.getElementById('forwardSelectedBtn').onclick = () => forwardSelectedMessages().catch((error) => showToast(error.message, true));
  document.getElementById('deleteSelectedBtn').onclick = async () => {
    if (!state.selectedMessageIds.length) return;
    if (!confirm(`Удалить выбранные сообщения (${state.selectedMessageIds.length})?`)) return;
    await deleteSelectedMessages();
  };
  document.getElementById('cancelSelectionBtn').onclick = () => {
    clearSelection();
    render();
  };
}

function renderPinnedBar() {
  if (!state.currentChat?.pinnedMessage) {
    el.pinnedBar.classList.add('hidden');
    el.pinnedBar.innerHTML = '';
    return;
  }
  const pinned = state.currentChat.pinnedMessage;
  el.pinnedBar.classList.remove('hidden');
  el.pinnedBar.innerHTML = `
    <div>
      <strong>📌 Закреплённое сообщение</strong>
      <div class="muted">${escapeHtml(pinned.content || pinned.attachmentName || 'Вложение')}</div>
    </div>
    <div class="inline-actions">
      <button id="jumpPinnedBtn" class="ghost-btn small">Перейти</button>
      ${canPinCurrentChat() ? '<button id="unpinPinnedBtn" class="ghost-btn small">Открепить</button>' : ''}
    </div>
  `;
  document.getElementById('jumpPinnedBtn').onclick = () => scrollToMessage(pinned.id);
  const unpinBtn = document.getElementById('unpinPinnedBtn');
  if (unpinBtn) {
    unpinBtn.onclick = async () => {
      try {
        const { chat } = await api(`/api/chats/${state.currentChat.id}/pin`, { method: 'DELETE' });
        state.currentChat = chat;
        render();
      } catch (error) {
        showToast(error.message, true);
      }
    };
  }
}

function renderTyping() {
  if (!state.currentChat) return (el.typingIndicator.textContent = '');
  const names = Object.values(state.typingUsers[state.currentChat.id] || {});
  el.typingIndicator.textContent = names.length ? `${names.join(', ')} печатает...` : '';
}

function groupReactions(reactions = []) {
  const map = new Map();
  reactions.forEach((reaction) => {
    const current = map.get(reaction.emoji) || { emoji: reaction.emoji, count: 0, mine: false };
    current.count += 1;
    if (reaction.user_id === state.user.id) current.mine = true;
    map.set(reaction.emoji, current);
  });
  return [...map.values()];
}

function scrollToMessage(messageId) {
  const element = document.getElementById(`message-${messageId}`);
  if (!element) return;
  element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  element.classList.add('message-highlight');
  setTimeout(() => element.classList.remove('message-highlight'), 1500);
}

async function toggleReaction(messageId, emoji) {
  await api(`/api/chats/messages/${messageId}/reactions`, { method: 'POST', body: { emoji } });
}

async function pinMessage(messageId) {
  const { chat } = await api(`/api/chats/${state.currentChat.id}/pin/${messageId}`, { method: 'POST' });
  state.currentChat = chat;
  renderPinnedBar();
}

async function forwardMessage(messageId) {
  const chats = state.chats.filter((chat) => chat.id !== state.currentChat?.id && !chat.archived);
  openModal(
    'Переслать сообщение',
    `
      <form class="modal-grid">
        <div class="form-card form-row">
          <label>Выберите чат</label>
          <select name="targetChatId" required>
            ${chats.map((chat) => `<option value="${chat.id}">${escapeHtml(chat.title)}${chat.username ? ` (@${escapeHtml(chat.username)})` : ''}</option>`).join('')}
          </select>
        </div>
        <button class="primary-btn" type="submit">Переслать</button>
      </form>
    `,
    async (formData) => {
      await api(`/api/chats/messages/${messageId}/forward`, { method: 'POST', body: { targetChatId: formData.get('targetChatId') } });
      closeModal();
      showToast('Сообщение переслано');
    }
  );
}

async function forwardSelectedMessages() {
  if (!state.selectedMessageIds.length) return;
  const chats = state.chats.filter((chat) => chat.id !== state.currentChat?.id && !chat.archived);
  openModal(
    'Переслать выбранные сообщения',
    `
      <form class="modal-grid">
        <div class="form-card form-row">
          <label>Выберите чат</label>
          <select name="targetChatId" required>
            ${chats.map((chat) => `<option value="${chat.id}">${escapeHtml(chat.title)}${chat.username ? ` (@${escapeHtml(chat.username)})` : ''}</option>`).join('')}
          </select>
        </div>
        <div class="muted">Будет переслано сообщений: ${state.selectedMessageIds.length}</div>
        <button class="primary-btn" type="submit">Переслать</button>
      </form>
    `,
    async (formData) => {
      await api('/api/chats/messages/forward-bulk', { method: 'POST', body: { targetChatId: formData.get('targetChatId'), messageIds: state.selectedMessageIds } });
      clearSelection();
      closeModal();
      render();
      showToast('Выбранные сообщения пересланы');
    }
  );
}

function openMessageEditor(message) {
  openModal(
    'Редактирование сообщения',
    `
      <form class="modal-grid">
        <div class="form-card form-row">
          <label>Текст сообщения</label>
          <textarea name="content" rows="6">${escapeValue(message.content || '')}</textarea>
        </div>
        <button class="primary-btn" type="submit">Сохранить</button>
      </form>
    `,
    async (formData) => {
      const content = String(formData.get('content') || '');
      await api(`/api/chats/messages/${message.id}`, { method: 'PATCH', body: { content } });
      closeModal();
      showToast('Сообщение обновлено');
    }
  );
}

// Открывает редактор сообщения для модерационной карточки.
// Используется, когда модератор хочет изменить сообщение из жалобы,
// при этом самого сообщения может не быть в памяти текущего чата.
async function openModerationMessageEditor(messageId) {
  let initialContent = '';
  try {
    const { message } = await api(`/api/chats/messages/${messageId}`);
    if (message && typeof message.content === 'string') initialContent = message.content;
  } catch (error) {
    // Если не удалось получить — всё равно покажем пустой редактор.
    console.warn('Cannot load reported message for moderation editor', error);
  }
  openModal(
    'Редактирование сообщения (модерация)',
    `
      <form class="modal-grid">
        <div class="form-card form-row">
          <label>Текст сообщения</label>
          <textarea name="content" rows="6">${escapeValue(initialContent)}</textarea>
        </div>
        <div class="muted">Сообщение будет изменено в исходном чате от лица его автора.</div>
        <button class="primary-btn" type="submit">Сохранить</button>
      </form>
    `,
    async (formData) => {
      const content = String(formData.get('content') || '');
      await api(`/api/chats/messages/${messageId}`, { method: 'PATCH', body: { content } });
      closeModal();
      showToast('Сообщение обновлено');
    }
  );
}

function openScheduleModal() {
  if (!state.currentChat) return;
  if (state.pendingFiles.length) {
    showToast('Отложенная отправка вложений пока не поддерживается. Отправьте текст без файлов.', true);
    return;
  }
  openModal(
    'Отложенная отправка',
    `
      <form class="modal-grid">
        <div class="form-card form-row">
          <label>Дата и время отправки</label>
          <input name="scheduledFor" type="datetime-local" required />
        </div>
        <div class="muted">Будет отправлен текущий текст из поля ввода.</div>
        <button class="primary-btn" type="submit">Запланировать</button>
      </form>
    `,
    async (formData) => {
      await api(`/api/chats/${state.currentChat.id}/scheduled`, {
        method: 'POST',
        body: {
          content: el.messageInput.value.trim(),
          replyToMessageId: state.replyTo?.id || null,
          scheduledFor: formData.get('scheduledFor')
        }
      });
      el.messageInput.value = '';
      setDraft(state.currentChat.id, '');
      state.replyTo = null;
      renderReplyBox();
      closeModal();
      showToast('Сообщение запланировано');
    }
  );
}

async function openCommentsModal(message) {
  openModal(
    'Комментарии',
    `
      <div class="modal-grid">
        <div class="form-card form-row">
          <div><strong>Пост</strong></div>
          <div>${escapeHtml(message.content || message.attachmentName || 'Вложение')}</div>
        </div>
        <div id="commentsList" class="members-box"><div class="muted">Загрузка...</div></div>
        <form id="commentForm" class="modal-grid">
          <div class="form-card form-row">
            <label>Комментарий</label>
            <textarea name="content" rows="4" placeholder="Напишите комментарий..."></textarea>
          </div>
          <button class="primary-btn" type="submit">Отправить комментарий</button>
        </form>
      </div>
    `
  );
  const list = document.getElementById('commentsList');
  async function refreshComments() {
    const { comments } = await api(`/api/chats/messages/${message.id}/comments`);
    list.innerHTML = comments.length ? comments.map((comment) => `
      <div class="member-row">
        <div><strong>${escapeHtml(userLabel(comment.author))}</strong>${comment.author.username ? ` <span class=\"muted\">@${escapeHtml(comment.author.username)}</span>` : ''}</div>
        <div>${escapeHtml(comment.content || '')}</div>
        <div class="muted">${formatMessageTime(comment.createdAt)}</div>
      </div>
    `).join('') : '<div class="muted">Комментариев пока нет.</div>';
  }
  refreshComments().catch((error) => { list.innerHTML = `<div class=\"muted\">${escapeHtml(error.message)}</div>`; });
  document.getElementById('commentForm').onsubmit = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const content = String(new FormData(form).get('content') || '');
    await api(`/api/chats/messages/${message.id}/comments`, { method: 'POST', body: { content } });
    form.reset();
    await refreshComments();
  };
}

function openSendContextMenu(x, y) {
  openContextMenu([
    { label: '⏰ Отправить позже', onClick: () => openScheduleModal() }
  ], x, y);
}

function openReactionPickerForMessage(message) {
  openModal(
    'Выберите реакцию',
    `<div class="emoji-grid">${COMMON_REACTIONS.concat(EMOJI_SET.slice(0, 12)).filter((emoji, index, list) => list.indexOf(emoji) === index).map((emoji) => `<button type="button" class="emoji-btn reaction-modal-btn" data-emoji="${emoji}">${emoji}</button>`).join('')}</div>`
  );
  document.querySelectorAll('.reaction-modal-btn').forEach((button) => {
    button.onclick = async () => {
      try {
        await toggleReaction(message.id, button.dataset.emoji);
        closeModal();
      } catch (error) {
        showToast(error.message, true);
      }
    };
  });
}

function openMessageContextMenu(message, x, y) {
  // Редактировать имеет право только автор или модератор.
  const canEdit = !message.deletedAt && (message.userId === state.user.id || canModerateMessagesInCurrentChat());
  // Удалить теперь разрешено любому участнику чата (любое сообщение).
  const canDelete = !message.deletedAt;
  const items = [
    { label: '↩ Ответить', onClick: () => { state.replyTo = message; renderReplyBox(); el.messageInput.focus(); } },
    { label: '⇢ Переслать', onClick: () => forwardMessage(message.id).catch((error) => showToast(error.message, true)) },
    { label: '☑ Выбрать', onClick: () => {
        // Включаем режим множественного выбора и сразу помечаем это сообщение.
        if (!state.selectMode) state.selectMode = true;
        if (!state.selectedMessageIds.includes(message.id)) {
          state.selectedMessageIds = [...state.selectedMessageIds, message.id];
        }
        renderSelectionBar();
        requestRenderMessages();
      } },
    { label: '😊 Реакции', onClick: () => openReactionPickerForMessage(message) },
    { label: '⚠ Пожаловаться', onClick: () => openReportModal({ reportedUserId: message.author.id, chatId: message.chatId, messageId: message.id }) }
  ];
  if (state.currentChat?.type === 'channel' && state.currentChat.restrictions?.commentsEnabled && !message.replyToMessageId) {
    items.push({ label: `💬 Комментарии (${message.commentsCount || 0})`, onClick: () => openCommentsModal(message).catch((error) => showToast(error.message, true)) });
  }
  if (canPinCurrentChat()) items.push({ label: '📌 Закрепить сообщение', onClick: () => pinMessage(message.id).catch((error) => showToast(error.message, true)) });
  if (canEdit) items.push({ label: '✎ Редактировать', onClick: () => openMessageEditor(message) });
  if (canDelete) items.push({ label: '🗑 Удалить', danger: true, onClick: async () => {
      if (!confirm('Удалить сообщение?')) return;
      try {
        await api(`/api/chats/messages/${message.id}`, { method: 'DELETE' });
      } catch (error) {
        showToast(error.message, true);
      }
    } });
  openContextMenu(items, x, y);
}

function attachmentMarkup(message) {
  if (!message.attachmentUrl) return '';
  const linkAttrs = mediaLinkAttrs(message.attachmentUrl, message.attachmentName || '');
  if (isAudioAttachment(message.attachmentName)) {
    return `<audio class="audio-player" controls ${mediaSourceAttrs(message.attachmentUrl)}></audio><canvas class="audio-waveform" width="220" height="42" data-waveform-src="${escapeValue(message.attachmentUrl)}"></canvas><div style="margin-top:8px"><a class="file-link" ${linkAttrs}>🎤 ${escapeHtml(message.attachmentName || 'Голосовое сообщение')}</a></div>`;
  }
  if (isImageAttachment(message.attachmentName)) {
    return `<button type="button" class="image-preview-btn"><img class="chat-image-preview" data-viewer-src="${escapeValue(message.attachmentUrl)}" data-viewer-caption="${escapeValue(message.attachmentName || 'Изображение')}" ${mediaSourceAttrs(message.attachmentUrl)} alt="${escapeValue(message.attachmentName || 'Изображение')}" /></button><div style="margin-top:8px"><a class="file-link" ${linkAttrs}>🖼 ${escapeHtml(message.attachmentName || 'Изображение')}</a></div>`;
  }
  if (isVideoAttachment(message.attachmentName)) {
    return `<video class="chat-video-preview" controls preload="metadata" ${mediaSourceAttrs(message.attachmentUrl)}></video><div style="margin-top:8px"><a class="file-link" ${linkAttrs}>🎬 ${escapeHtml(message.attachmentName || 'Видео')}</a></div>`;
  }
  return `<div style="margin-top:10px"><a class="file-link" ${linkAttrs}>📎 ${escapeHtml(message.attachmentName || 'Файл')}</a></div>`;
}

function buildMessageGroups(messages) {
  const groups = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (message.albumId) {
      const albumMessages = [message];
      let j = i + 1;
      while (j < messages.length && messages[j].albumId === message.albumId) {
        albumMessages.push(messages[j]);
        j += 1;
      }
      groups.push({ type: 'album', messages: albumMessages });
      i = j - 1;
    } else {
      groups.push({ type: 'message', message });
    }
  }
  return groups;
}

function requestRenderMessages() {
  if (state.renderMessageTimer) {
    clearTimeout(state.renderMessageTimer);
  }
  state.renderMessageTimer = setTimeout(() => {
    renderMessages();
    state.renderMessageTimer = null;
  }, 50);
}

function renderMessages() {
  if (!state.currentChat) {
    el.messageList.className = 'message-list empty-state';
    el.messageList.innerHTML = '<div class="placeholder"><h2>Выберите чат</h2><p>Теперь доступны Saved Messages, forward, закрепы, ссылки и медиа-галерея.</p></div>';
    return;
  }

  const shouldScroll = el.messageList.scrollTop >= el.messageList.scrollHeight - el.messageList.clientHeight - 100;

  el.messageList.className = 'message-list';
  const messages = normalizeChatMessages(state.messagesByChat[state.currentChat.id] || []);
  const visibleMessages = state.currentChat.type === 'channel' ? messages.filter((message) => !message.replyToMessageId) : messages;
  const groups = buildMessageGroups(visibleMessages);
  
  const fragment = document.createDocumentFragment();

  groups.forEach((entry) => {
    const albumMessages = entry.type === 'album' ? entry.messages : null;
    const message = albumMessages ? albumMessages[0] : entry.message;
    const grouped = groupReactions(message.reactions);
    const canEdit = !message.deletedAt && (message.userId === state.user.id || canModerateMessagesInCurrentChat());
    // Удаление разрешено всем участникам чата (для своих и чужих сообщений).
    const canDelete = !message.deletedAt;
    const canPin = canPinCurrentChat() && !message.deletedAt;
    const selected = albumMessages
      ? albumMessages.some((item) => state.selectedMessageIds.includes(item.id))
      : state.selectedMessageIds.includes(message.id);
    const row = document.createElement('div');
    row.className = `message-row ${message.userId === state.user.id ? 'mine' : 'theirs'} ${selected ? 'selected' : ''}`;
    row.id = `message-${message.id}`;

    const albumGrid = albumMessages
      ? `<div class="album-grid">${albumMessages
          .map(
            (item) => `<button type="button" class="image-preview-btn album-tile"><img class="chat-image-preview album-image" data-viewer-src="${escapeValue(item.attachmentUrl)}" data-viewer-caption="${escapeValue(item.attachmentName || 'Изображение')}" ${mediaSourceAttrs(item.attachmentUrl)} alt="${escapeValue(item.attachmentName || 'Изображение')}" /></button>`
          )
          .join('')}</div>`
      : '';

    row.innerHTML = `
      <div class="message-bubble">
        <div class="message-tools">
          <button class="msg-tool reply-btn" title="Ответить">↩</button>
          <button class="msg-tool react-toggle-btn" title="Реакция">😊</button>
          <button class="msg-tool forward-btn" title="Переслать">⇢</button>
          <button class="msg-tool select-btn" title="Выбрать">☑</button>
          ${canPin ? '<button class="msg-tool pin-btn" title="Закрепить">📌</button>' : ''}
          ${canEdit && !albumMessages ? '<button class="msg-tool edit-btn" title="Изменить">✎</button>' : ''}
          ${canDelete ? '<button class="msg-tool delete-btn" title="Удалить">🗑</button>' : ''}
          <div class="reaction-picker hidden">
            ${COMMON_REACTIONS.map((emoji) => `<button type="button" class="reaction-option" data-emoji="${emoji}">${emoji}</button>`).join('')}
          </div>
        </div>
        ${state.currentChat.type !== 'private' || state.currentChat.isSaved ? `<button type="button" class="message-author user-link" data-author-id="${message.author.id}">${escapeHtml(userLabel(message.author))}${message.author.username ? ` · @${escapeHtml(message.author.username)}` : ''}</button>` : ''}
        ${message.report && state.currentChat.isModeration ? `<div class="moderation-card">
          <div><strong>Жалоба: ${escapeHtml(message.report.reason)}</strong> · <span class="muted">${escapeHtml(message.report.status)}</span></div>
          ${message.report.reporterName ? `<div class=\"muted\">От: ${escapeHtml(message.report.reporterName)}</div>` : ''}
          ${message.report.reportedName ? `<div class=\"muted\">На: ${escapeHtml(message.report.reportedName)}</div>` : ''}
          ${message.report.details ? `<div class=\"muted\">${escapeHtml(message.report.details)}</div>` : ''}
          <div class="inline-actions moderation-actions">
            <button type="button" class="secondary-btn report-quick-action" data-report-id="${message.report.id}" data-action="review">В работу</button>
            <button type="button" class="secondary-btn report-quick-action" data-report-id="${message.report.id}" data-action="resolve">Решено</button>
            <button type="button" class="ghost-btn danger-btn report-quick-action" data-report-id="${message.report.id}" data-action="dismiss">Отклонить</button>
            ${message.report.reportedUserId ? `<button type=\"button\" class=\"secondary-btn report-open-profile\" data-profile-id=\"${message.report.reportedUserId}\">Профиль</button>` : ''}
            ${message.report.messageId ? `<button type=\"button\" class=\"secondary-btn report-edit-message\" data-message-id=\"${message.report.messageId}\" data-chat-id=\"${message.report.chatId || ''}\">✎ Изменить сообщение</button>` : ''}
            ${message.report.messageId ? `<button type=\"button\" class=\"ghost-btn danger-btn report-delete-message\" data-message-id=\"${message.report.messageId}\" data-report-id=\"${message.report.id}\">🗑 Удалить сообщение</button>` : ''}
            ${message.report.chatId && message.report.reportedUserId ? `<button type=\"button\" class=\"ghost-btn danger-btn report-quick-action\" data-report-id=\"${message.report.id}\" data-action=\"mute_60\">Мут 60м</button><button type=\"button\" class=\"ghost-btn danger-btn report-quick-action\" data-report-id=\"${message.report.id}\" data-action=\"ban_1440\">Бан 24ч</button>` : ''}
          </div>
        </div>` : ''}
        ${message.forwardedFrom ? `<button type="button" class="reply-preview user-link forwarded-link" data-forward-user-id="${message.forwardedFrom.userId}"><strong>Переслано от ${escapeHtml(userLabel(message.forwardedFrom))}</strong>${message.forwardedFrom.username ? `<br />@${escapeHtml(message.forwardedFrom.username)}` : ''}</button>` : ''}
        ${message.replyPreview ? `<button type="button" class="reply-preview jump-reply" data-reply-id="${message.replyToMessageId}"><strong>${escapeHtml(message.replyPreview.authorName)}</strong><br />${escapeHtml(message.replyPreview.content || message.replyPreview.attachmentName || 'Вложение')}</button>` : ''}
        <div class="message-content ${isStickerContent(message.content) ? 'sticker-message' : ''}">${isStickerContent(message.content) ? escapeHtml(normalizeStickerDisplay(message.content)) : escapeHtml(message.content || '')}</div>
        ${albumMessages ? albumGrid : attachmentMarkup(message)}
        ${state.currentChat.type === 'channel' && state.currentChat.restrictions?.commentsEnabled && !message.replyToMessageId ? `<button type="button" class="comments-link" data-comments-for="${message.id}">💬 Комментарии ${message.commentsCount ? `(${message.commentsCount})` : ''}</button>` : ''}
        <div class="reactions">${grouped.map((item) => `<button type="button" class="reaction-chip ${item.mine ? 'mine' : ''}" data-emoji="${item.emoji}">${item.emoji} ${item.count}</button>`).join('')}</div>
        <div class="message-meta"><span>${formatMessageTime(message.createdAt)}</span>${albumMessages ? `<span>альбом · ${albumMessages.length}</span>` : ''}${message.editedAt ? '<span>изменено</span>' : ''}${messageStatusLabel(message) ? `<span class="status-checks">${messageStatusLabel(message)}</span>` : ''}</div>
      </div>
    `;

    row.oncontextmenu = (event) => {
      event.preventDefault();
      if (shouldIgnoreMessageContextTarget(event.target)) return;
      openMessageContextMenu(message, event.clientX, event.clientY);
    };
    let longPressTimer = null;
    row.addEventListener('touchstart', (event) => {
      if (state.selectMode || shouldIgnoreMessageContextTarget(event.target)) return;
      const touch = event.changedTouches?.[0];
      if (!touch) return;
      longPressTimer = setTimeout(() => {
        openMessageContextMenu(message, touch.clientX, touch.clientY);
      }, 420);
    }, { passive: true });
    ['touchend', 'touchcancel', 'touchmove'].forEach((name) => {
      row.addEventListener(name, () => {
        if (longPressTimer) {
          clearTimeout(longPressTimer);
          longPressTimer = null;
        }
      }, { passive: true });
    });
    const commentsBtn = row.querySelector('[data-comments-for]');
    if (commentsBtn) commentsBtn.onclick = () => openCommentsModal(message).catch((error) => showToast(error.message, true));

    if (!isMobileViewport() && !state.selectMode) {
      row.onclick = (event) => {
        if (shouldIgnoreMessageContextTarget(event.target)) return;
        openMessageContextMenu(message, event.clientX, event.clientY);
      };
    } else if (state.selectMode) {
      row.onclick = () => {
        if (albumMessages) {
          const allSelected = albumMessages.every((item) => state.selectedMessageIds.includes(item.id));
          albumMessages.forEach((item) => {
            if (allSelected) {
              state.selectedMessageIds = state.selectedMessageIds.filter((id) => id !== item.id);
            } else if (!state.selectedMessageIds.includes(item.id)) {
              state.selectedMessageIds.push(item.id);
            }
          });
          renderSelectionBar();
          requestRenderMessages();
        } else {
          toggleMessageSelection(message.id);
        }
      };
    } else {
      row.ondblclick = () => {
        state.replyTo = message;
        renderReplyBox();
        el.messageInput.focus();
      };
    }

    const selectBtn = row.querySelector('.select-btn');
    if (selectBtn) {
      selectBtn.onclick = (event) => {
        event.stopPropagation();
        // Автоматически включаем режим множественного выбора, если он ещё выключен.
        if (!state.selectMode) state.selectMode = true;
        if (albumMessages) {
          albumMessages.forEach((item) => toggleMessageSelection(item.id));
        } else {
          toggleMessageSelection(message.id);
        }
        renderSelectionBar();
        requestRenderMessages();
      };
    }

    row.querySelector('.reply-btn').onclick = (event) => {
      event.stopPropagation();
      state.replyTo = message;
      renderReplyBox();
      el.messageInput.focus();
    };
    row.querySelector('.forward-btn').onclick = (event) => {
      event.stopPropagation();
      forwardMessage(message.id).catch((error) => showToast(error.message, true));
    };
    const pinBtn = row.querySelector('.pin-btn');
    if (pinBtn) {
      pinBtn.onclick = (event) => {
        event.stopPropagation();
        pinMessage(message.id).catch((error) => showToast(error.message, true));
      };
    }

    const reactToggle = row.querySelector('.react-toggle-btn');
    const picker = row.querySelector('.reaction-picker');
    reactToggle.onclick = (event) => {
      event.stopPropagation();
      document.querySelectorAll('.reaction-picker').forEach((node) => {
        if (node !== picker) node.classList.add('hidden');
      });
      picker.classList.toggle('hidden');
    };

    row.querySelectorAll('.reaction-option').forEach((button) => {
      button.onclick = async () => {
        try {
          picker.classList.add('hidden');
          await toggleReaction(message.id, button.dataset.emoji);
        } catch (error) {
          showToast(error.message, true);
        }
      };
    });

    row.querySelectorAll('.reaction-chip').forEach((button) => {
      button.onclick = async () => {
        try {
          await toggleReaction(message.id, button.dataset.emoji);
        } catch (error) {
          showToast(error.message, true);
        }
      };
    });

    row.querySelectorAll('.report-quick-action').forEach((button) => {
      button.onclick = async () => {
        try {
          await applyModerationAction(button.dataset.reportId, button.dataset.action);
        } catch (error) {
          showToast(error.message, true);
        }
      };
    });
    row.querySelectorAll('.report-open-profile').forEach((button) => {
      button.onclick = () => openUserProfileModal(button.dataset.profileId).catch((error) => showToast(error.message, true));
    });
    // Кнопка модерации "Удалить сообщение" — удаляет именно то сообщение,
    // на которое отправлена жалоба.
    row.querySelectorAll('.report-delete-message').forEach((button) => {
      button.onclick = async (event) => {
        event.stopPropagation();
        if (!button.dataset.messageId) return;
        if (!confirm('Удалить сообщение, на которое отправлена жалоба?')) return;
        try {
          await api(`/api/chats/messages/${button.dataset.messageId}`, { method: 'DELETE' });
          // Помечаем жалобу как решённую, чтобы она не висела в списке.
          if (button.dataset.reportId) {
            try { await applyModerationAction(button.dataset.reportId, 'resolve'); } catch {}
          }
          showToast('Сообщение удалено');
        } catch (error) {
          showToast(error.message, true);
        }
      };
    });
    // Кнопка модерации "Изменить сообщение" — открывает модалку
    // редактирования сообщения, на которое отправлена жалоба.
    row.querySelectorAll('.report-edit-message').forEach((button) => {
      button.onclick = async (event) => {
        event.stopPropagation();
        if (!button.dataset.messageId) return;
        try {
          openModerationMessageEditor(button.dataset.messageId);
        } catch (error) {
          showToast(error.message, true);
        }
      };
    });

    const authorBtn = row.querySelector('[data-author-id]');
    if (authorBtn) authorBtn.onclick = () => openUserProfileModal(authorBtn.dataset.authorId).catch((error) => showToast(error.message, true));
    const forwardedBtn = row.querySelector('[data-forward-user-id]');
    if (forwardedBtn) forwardedBtn.onclick = () => openUserProfileModal(forwardedBtn.dataset.forwardUserId).catch((error) => showToast(error.message, true));
    const jumpReply = row.querySelector('.jump-reply');
    if (jumpReply) jumpReply.onclick = () => scrollToMessage(jumpReply.dataset.replyId);

    if (canEdit && !albumMessages) {
      row.querySelector('.edit-btn').onclick = (event) => {
        event.stopPropagation();
        openMessageEditor(message);
      };
    }
    if (canDelete) {
      const deleteBtn = row.querySelector('.delete-btn');
      if (deleteBtn) {
        deleteBtn.onclick = async (event) => {
          event.stopPropagation();
          if (!confirm(albumMessages ? 'Удалить весь альбом?' : 'Удалить сообщение?')) return;
          try {
            if (albumMessages) {
              for (const item of albumMessages) await api(`/api/chats/messages/${item.id}`, { method: 'DELETE' });
            } else {
              await api(`/api/chats/messages/${message.id}`, { method: 'DELETE' });
            }
          } catch (error) {
            showToast(error.message, true);
          }
        };
      }
    }

    fragment.appendChild(row);
  });

  el.messageList.innerHTML = '';
  el.messageList.appendChild(fragment);

  mountWaveforms(el.messageList);
  hydrateProtectedMedia(el.messageList);
  
  if (shouldScroll) {
    el.messageList.scrollTop = el.messageList.scrollHeight;
  }
}

function renderReplyBox() {
  if (!state.replyTo) {
    el.replyBox.classList.add('hidden');
    el.replyBox.innerHTML = '';
    return;
  }
  el.replyBox.classList.remove('hidden');
  el.replyBox.innerHTML = `
    <div class="reply-box-main">
      <div><strong>${escapeHtml(userLabel(state.replyTo.author))}</strong></div>
      <div class="muted">${escapeHtml(state.replyTo.content || state.replyTo.attachmentName || 'Вложение')}</div>
    </div>
    <div class="reply-box-actions">
      <button id="jumpReplyOriginBtn" class="ghost-btn small">Перейти</button>
      <button id="cancelReplyBtn" class="ghost-btn small">Отмена</button>
    </div>
  `;
  document.getElementById('jumpReplyOriginBtn').onclick = () => scrollToMessage(state.replyTo.id);
  document.getElementById('cancelReplyBtn').onclick = () => {
    state.replyTo = null;
    renderReplyBox();
  };
}

function renderFilterButtons() {
  el.chatFilters.querySelectorAll('.folder-chip-custom').forEach((button) => button.remove());
  const archiveBtn = el.chatFilters.querySelector('[data-filter="archive"]');
  if (archiveBtn) archiveBtn.classList.toggle('hidden', state.settings.showArchiveTab === false);
  state.chatFolders.forEach((folder) => {
    const button = document.createElement('button');
    button.className = 'filter-chip folder-chip-custom';
    button.dataset.filter = folderChipId(folder.id);
    button.textContent = folder.name;
    el.chatFilters.appendChild(button);
  });
  if ((state.chatFilter === 'favorite' && state.settings.showFavoriteTab === false) || (state.chatFilter === 'archive' && state.settings.showArchiveTab === false)) {
    state.chatFilter = 'all';
  }
  el.chatFilters.querySelectorAll('[data-filter]').forEach((button) => {
    button.classList.toggle('active', !button.classList.contains('hidden') && button.dataset.filter === state.chatFilter);
  });
}

function render() {
  const loggedIn = Boolean(state.token && state.user);
  el.authScreen.classList.toggle('hidden', loggedIn);
  el.appScreen.classList.toggle('hidden', !loggedIn);
  if (!loggedIn) {
    el.displayNameStep.classList.toggle('hidden', state.authUserExists !== false);
    el.authModeHint.textContent = state.authUserExists === false ? 'Похоже, это новый номер. Укажите имя только для первой регистрации.' : state.authUserExists === true ? 'Номер уже зарегистрирован — просто введите код.' : '';
    return;
  }
  applySettings();
  syncMobileLayout();
  renderSidebarProfile();
  renderFilterButtons();
  renderSearchResults();
  renderChats();
  renderChatHeader();
  renderPinnedBar();
  renderSelectionBar();
  renderPendingFiles();
  renderMessages();
  renderReplyBox();
}

async function refreshChats({ showSkeleton = false } = {}) {
  if (showSkeleton) renderChatListSkeleton();
  const { chats } = await api('/api/chats');
  state.chats = chats;
  if (state.currentChat) {
    const refreshed = chats.find((chat) => chat.id === state.currentChat.id);
    if (refreshed) state.currentChat = { ...state.currentChat, ...refreshed };
  }
  render();
}

async function searchUsers(query) {
  if (!query.trim()) {
    state.userSearchResults = [];
    renderSearchResults();
    return;
  }
  try {
    const { users } = await api(`/api/users/search?q=${encodeURIComponent(query.trim())}`);
    state.userSearchResults = users;
    renderSearchResults();
  } catch (error) {
    console.warn('Search failed', error);
  }
}

async function loadChatDetails(chatId) {
  const result = await api(`/api/chats/${chatId}`);
  return result.chat;
}

async function openChat(chatId) {
  let chat = state.chats.find((item) => item.id === chatId);
  if (!chat) {
    await refreshChats();
    chat = state.chats.find((item) => item.id === chatId);
    if (!chat) return;
  }
  state.currentChat = await loadChatDetails(chatId);
  closeMobileTools();
  state.socket?.emit('chat:join', { chatId });
  showSkeleton(el.messageList, 'messages');
  const { messages } = await api(`/api/chats/${chatId}/messages`);
  state.messagesByChat[chatId] = normalizeChatMessages(messages);
  el.messageInput.value = getDraft(chatId);
  render();
  await api(`/api/chats/${chatId}/read`, { method: 'POST' }).catch(() => {});
}

async function updateChatPreference(chat, changes) {
  const { chat: updated } = await api(`/api/chats/${chat.id}/preferences`, { method: 'PATCH', body: changes });
  const index = state.chats.findIndex((item) => item.id === chat.id);
  if (index >= 0) state.chats[index] = { ...state.chats[index], ...updated };
  if (state.currentChat?.id === chat.id) state.currentChat = { ...state.currentChat, ...updated };
  render();
}

function openChatActions(chat) {
  openModal(
    chat.title,
    `
      <div class="modal-grid">
        <div class="form-card form-row">
          <div><strong>${escapeHtml(chat.title)}</strong></div>
          <div class="muted">${chat.username ? '@' + escapeHtml(chat.username) : chat.isSaved ? 'Saved Messages' : chat.type === 'private' && chat.peer?.username ? '@' + escapeHtml(chat.peer.username) : chatTypeLabel(chat)}</div>
        </div>
        <button id="chatTogglePinnedBtn" class="secondary-btn">${chat.pinned ? 'Открепить чат' : 'Закрепить чат'}</button>
        <button id="chatToggleArchiveBtn" class="secondary-btn">${chat.archived ? 'Вернуть из архива' : 'Отправить в архив'}</button>
        <button id="chatOpenSettingsBtn" class="primary-btn">${chat.type === 'private' ? 'Информация' : 'Настройки чата'}</button>
        ${chat.isSaved ? '' : `<button id="chatLeaveBtn" class="ghost-btn danger-btn">${chat.type === 'private' ? 'Удалить чат' : chat.viewerRole === 'owner' ? 'Удалить чат' : 'Покинуть чат'}</button>`}
        ${!chat.isSaved ? `<button id="chatClearHistoryBtn" class="ghost-btn secondary-btn">Очистить историю</button>` : ''}
      </div>
    `
  );

  document.getElementById('chatTogglePinnedBtn').onclick = async () => {
    try {
      await updateChatPreference(chat, { pinned: !chat.pinned, favorite: chat.favorite, archived: chat.archived });
      closeModal();
    } catch (error) {
      showToast(error.message, true);
    }
  };
  document.getElementById('chatToggleArchiveBtn').onclick = async () => {
    try {
      await updateChatPreference(chat, { archived: !chat.archived, favorite: chat.favorite, pinned: chat.pinned });
      closeModal();
    } catch (error) {
      showToast(error.message, true);
    }
  };
  const deleteBtn = document.getElementById('chatLeaveBtn');
  if (deleteBtn) {
    deleteBtn.onclick = async () => {
      const isOwner = chat.viewerRole === 'owner';
      const label = isOwner ? 'Удалить чат для всех?' : (chat.type === 'private' ? 'Удалить чат из списка?' : 'Покинуть чат?');
      if (!confirm(label)) return;
      try {
        await api(`/api/chats/${chat.id}`, { method: 'DELETE' });
        if (state.currentChat?.id === chat.id) state.currentChat = null;
        closeModal();
        await refreshChats();
      } catch (error) {
        showToast(error.message, true);
      }
    };
  }
  const clearBtn = document.getElementById('chatClearHistoryBtn');
  if (clearBtn) {
    clearBtn.onclick = async () => {
      if (!confirm('Вы уверены, что хотите полностью очистить историю переписки?')) return;
      try {
        await api(`/api/chats/${chat.id}/clear`, { method: 'DELETE' });
        if (state.currentChat?.id === chat.id) {
          state.messagesByChat[chat.id] = [];
          requestRenderMessages();
        }
        closeModal();
        showToast('История очищена');
      } catch (error) {
        showToast(error.message, true);
      }
    };
  }
  document.getElementById('chatOpenSettingsBtn').onclick = async () => {
    closeModal();
    await openChatInfoModal(chat.id);
  };
}

function canManageCurrentMembers() {
  return ['owner', 'admin'].includes(state.currentChat?.viewerRole);
}

async function openSessionsModal() {
  const { sessions, currentSessionId } = await api('/api/auth/sessions');
  openModal(
    'Устройства и сессии',
    `
      <div class="modal-grid">
        ${sessions.map((session) => `
          <div class="member-row">
            <div><strong>${escapeHtml(session.title || 'Устройство')}</strong>${session.id === currentSessionId ? ' <span class=\"muted\">(текущая)</span>' : ''}</div>
            <div class="muted">IP: ${escapeHtml(session.ip_address || '-')}</div>
            <div class="muted">Создано: ${formatMessageTime(session.created_at)}</div>
            <div class="muted">Последняя активность: ${formatMessageTime(session.last_seen_at)}</div>
            ${!session.revoked_at && session.id !== currentSessionId ? `<button type="button" class="ghost-btn danger-btn revoke-session-btn" data-session-id="${session.id}">Завершить</button>` : session.revoked_at ? '<div class=\"muted\">Сессия завершена</div>' : ''}
          </div>
        `).join('')}
      </div>
    `
  );
  document.querySelectorAll('.revoke-session-btn').forEach((button) => {
    button.onclick = async () => {
      await api(`/api/auth/sessions/${button.dataset.sessionId}`, { method: 'DELETE' });
      closeModal();
      await openSessionsModal();
    };
  });
}

async function openReportModal(payload = {}) {
  openModal(
    'Жалоба',
    `
      <form class="modal-grid">
        <div class="form-card form-row">
          <label>Причина</label>
          <select name="reason">
            <option value="spam">Спам</option>
            <option value="abuse">Оскорбления</option>
            <option value="fraud">Мошенничество</option>
            <option value="other">Другое</option>
          </select>
        </div>
        <div class="form-card form-row">
          <label>Подробности</label>
          <textarea name="details" rows="4" placeholder="Опишите проблему..."></textarea>
        </div>
        <button class="primary-btn" type="submit">Отправить жалобу</button>
      </form>
    `,
    async (formData) => {
      await api('/api/users/reports', {
        method: 'POST',
        body: {
          reportedUserId: payload.reportedUserId || null,
          chatId: payload.chatId || null,
          messageId: payload.messageId || null,
          reason: formData.get('reason'),
          details: formData.get('details')
        }
      });
      closeModal();
      showToast('Жалоба отправлена');
    }
  );
}

async function openRestrictionModal(member) {
  openModal(
    'Ограничения участника',
    `
      <form class="modal-grid">
        <div class="form-card form-row">
          <div><strong>${escapeHtml(member.displayName)}</strong></div>
          <div class="muted">${member.username ? '@' + escapeHtml(member.username) : ''}</div>
        </div>
        <div class="form-card form-row">
          <label>Режим</label>
          <select name="mode">
            <option value="clear">Снять ограничения</option>
            <option value="mute">Мут</option>
            <option value="ban">Бан</option>
          </select>
        </div>
        <div class="form-card form-row">
          <label>Срок в минутах</label>
          <input name="minutes" type="number" min="0" value="60" />
        </div>
        <div class="form-card form-row">
          <label>Причина</label>
          <textarea name="reason" rows="3" placeholder="Причина ограничения"></textarea>
        </div>
        <button class="primary-btn" type="submit">Применить</button>
      </form>
    `,
    async (formData) => {
      await api(`/api/chats/${state.currentChat.id}/members/${member.id}/restrictions`, {
        method: 'PATCH',
        body: {
          mode: formData.get('mode'),
          minutes: Number(formData.get('minutes') || 0),
          reason: formData.get('reason')
        }
      });
      closeModal();
      await openChatInfoModal(state.currentChat.id);
    }
  );
}

async function openModerationPanel() {
  const { reports } = await api('/api/users/moderation/reports');
  openModal(
    'Модерация',
    `
      <div class="modal-grid">
        ${reports.length ? reports.map((report) => `
          <div class="member-row">
            <div><strong>${escapeHtml(report.reason)}</strong> · <span class="muted">${escapeHtml(report.status)}</span></div>
            <div class="muted">От: ${escapeHtml(report.reporter_name || report.reporter_username || 'unknown')}</div>
            <div class="muted">На: ${escapeHtml(report.reported_name || report.reported_username || 'контент')}</div>
            ${report.details ? `<div>${escapeHtml(report.details)}</div>` : ''}
          </div>
        `).join('') : '<div class=\"muted\">Жалоб пока нет.</div>'}
      </div>
    `
  );
}

async function openModerationChat() {
  const { chatId } = await api('/api/users/moderation/chat');
  closeDrawer();
  await refreshChats();
  await openChat(chatId);
}

async function applyModerationAction(reportId, action) {
  await api(`/api/users/moderation/reports/${reportId}/action`, { method: 'POST', body: { action } });
}

async function openUserProfileModal(userId) {
  if (!userId) return;
  if (state.user?.id === userId) return openProfileModal();
  const { user } = await api(`/api/users/${userId}`);
  const { blocked } = await api(`/api/users/block-status/${userId}`);
  openModal(
    'Профиль пользователя',
    `
      <div class="modal-grid">
        <div class="form-card profile-top">
          ${avatarMarkup(user.displayName, user.avatarUrl, 'avatar large')}
          <div class="form-row">
            <div><strong>${escapeHtml(user.displayName)}</strong></div>
            <div class="muted">${user.username ? '@' + escapeHtml(user.username) : 'Без username'}</div>
            <div class="muted">${user.phone ? escapeHtml(user.phone) : 'Телефон скрыт'}</div>
            <div class="muted">${escapeHtml(formatLastSeen(user))}</div>
          </div>
        </div>
        <div class="form-card form-row">
          <label>О себе</label>
          <div>${user.bio ? escapeHtml(user.bio) : '<span class="muted">Пользователь пока ничего не рассказал о себе.</span>'}</div>
        </div>
        <div class="form-card form-row">
          <div><strong>Общие чаты</strong></div>
          <div class="muted">${Number(user.sharedChatsCount || 0)} чат(ов)</div>
        </div>
        <div class="inline-actions">
          <button id="profileOpenDialogBtn" class="primary-btn">Открыть диалог</button>
          <button id="profileBlockBtn" class="ghost-btn ${blocked ? 'secondary-btn' : 'danger-btn'}">${blocked ? 'Разблокировать' : 'Заблокировать'}</button>
        </div>
      </div>
    `
  );
  document.getElementById('profileOpenDialogBtn').onclick = async () => {
    try {
      const { chat } = await api('/api/chats/private', { method: 'POST', body: { userId } });
      closeModal();
      await refreshChats();
      await openChat(chat.id);
    } catch (error) {
      showToast(error.message, true);
    }
  };
  document.getElementById('profileBlockBtn').onclick = async () => {
    try {
      if (blocked) {
        await api(`/api/users/block/${userId}`, { method: 'DELETE' });
        showToast('Пользователь разблокирован');
      } else {
        await api(`/api/users/block`, { method: 'POST', body: { userId } });
        showToast('Пользователь заблокирован');
      }
      openUserProfileModal(userId);
    } catch (error) {
      showToast(error.message, true);
    }
  };
}

function openProfileModal() {
  openEditorModal(
    'Профиль',
    `
      <form class="modal-grid">
        <div class="form-card profile-top">
          ${avatarMarkup(state.user.displayName, state.user.avatarUrl, 'avatar large')}
          <div class="form-row">
            <div><strong>${escapeHtml(state.user.displayName)}</strong></div>
            <div class="muted">${escapeHtml(state.user.phone)}</div>
            <div class="muted">${state.user.username ? '@' + escapeHtml(state.user.username) : 'Username ещё не задан'}</div>
            <div>
              <label>Новый аватар</label>
              <input name="avatar" type="file" accept="image/*" />
            </div>
          </div>
        </div>
        <div class="form-card form-row">
          <label>Имя</label>
          <input name="displayName" value="${escapeValue(state.user.displayName)}" required />
        </div>
        <div class="form-card form-row">
          <label>Username</label>
          <input name="username" value="${escapeValue(state.user.username || '')}" placeholder="my_username" />
        </div>
        <div class="form-card form-row">
          <label>О себе</label>
          <textarea name="bio" rows="4" placeholder="Несколько слов о себе">${escapeValue(state.user.bio || '')}</textarea>
        </div>
        <button class="primary-btn" type="submit">Сохранить профиль</button>
      </form>
    `,
    async (formData) => {
      const updated = await api('/api/users/me', {
        method: 'PATCH',
        body: {
          displayName: formData.get('displayName'),
          username: formData.get('username'),
          bio: formData.get('bio')
        }
      });
      updateStoredUser(updated.user);
      const avatarFile = formData.get('avatar');
      if (avatarFile && avatarFile.size) {
        const avatarData = new FormData();
        avatarData.append('avatar', avatarFile);
        const avatarUpdated = await api('/api/users/me/avatar', { method: 'POST', body: avatarData });
        updateStoredUser(avatarUpdated.user);
      }
      closeModal();
      render();
      showToast('Профиль обновлён');
    }
  );
}

function openSettingsModal() {
  openModal(
    'Настройки',
    `
      <form class="modal-grid">
        <div class="settings-option">
          <div><strong>Тема оформления</strong><div class="muted">Dark, Accent и Light.</div></div>
          <select name="theme" style="max-width:180px">
            <option value="dark" ${state.settings.theme === 'dark' ? 'selected' : ''}>Dark</option>
            <option value="telegram" ${state.settings.theme === 'telegram' ? 'selected' : ''}>Accent</option>
            <option value="light" ${state.settings.theme === 'light' ? 'selected' : ''}>Light</option>
          </select>
        </div>
        <div class="settings-option">
          <div><strong>Компактный список чатов</strong><div class="muted">Больше чатов помещается слева.</div></div>
          <input class="switch" type="checkbox" name="compactChats" ${state.settings.compactChats ? 'checked' : ''} />
        </div>
        <div class="settings-option">
          <div><strong>Акцентный цвет</strong><div class="muted">Выберите мягкий цвет интерфейса или задайте свой.</div></div>
          <input id="accentColorInput" type="color" name="accentColor" value="${escapeValue(state.settings.accentColor || '#4da3ff')}" style="width:64px;height:40px;padding:4px" />
        </div>
        <div class="form-card form-row">
          <div><strong>Быстрые цвета</strong></div>
          <div class="inline-actions">
            ${['#4da3ff','#5b9cff','#7c8cff','#57c6a9','#ff9f6b','#d38bff','#f071a6','#ffd166'].map((color) => `<button type="button" class="accent-preset" data-accent="${color}" style="background:${color}"></button>`).join('')}
          </div>
        </div>
        <div class="settings-option">
          <div><strong>Показывать вкладку «Избранные»</strong></div>
          <input class="switch" type="checkbox" name="showFavoriteTab" ${state.settings.showFavoriteTab !== false ? 'checked' : ''} />
        </div>
        <div class="settings-option">
          <div><strong>Показывать вкладку «Архив»</strong></div>
          <input class="switch" type="checkbox" name="showArchiveTab" ${state.settings.showArchiveTab !== false ? 'checked' : ''} />
        </div>
        <div class="settings-option">
          <div><strong>Отправка по Enter</strong><div class="muted">Shift + Enter — новая строка.</div></div>
          <input class="switch" type="checkbox" name="sendOnEnter" ${state.settings.sendOnEnter ? 'checked' : ''} />
        </div>
        <div class="settings-option">
          <div><strong>Показывать превью в списке чатов</strong><div class="muted">Можно сделать список минималистичнее.</div></div>
          <input class="switch" type="checkbox" name="showPreviews" ${state.settings.showPreviews ? 'checked' : ''} />
        </div>
        <div class="settings-option">
          <div><strong>Кто видит телефон</strong><div class="muted">Можно скрыть номер для других пользователей.</div></div>
          <select name="phoneVisibility" style="max-width:180px">
            <option value="everyone" ${state.settings.phoneVisibility === 'everyone' ? 'selected' : ''}>Все</option>
            <option value="nobody" ${state.settings.phoneVisibility === 'nobody' ? 'selected' : ''}>Никто</option>
          </select>
        </div>
        <div class="settings-option">
          <div><strong>Кто видит last seen</strong><div class="muted">Показывать ли время вашего последнего онлайна.</div></div>
          <select name="lastSeenVisibility" style="max-width:180px">
            <option value="everyone" ${state.settings.lastSeenVisibility === 'everyone' ? 'selected' : ''}>Все</option>
            <option value="nobody" ${state.settings.lastSeenVisibility === 'nobody' ? 'selected' : ''}>Никто</option>
          </select>
        </div>
        <div class="settings-option">
          <div><strong>Поиск по username</strong><div class="muted">Если отключить — по вашему @username нельзя будет найти аккаунт.</div></div>
          <input class="switch" type="checkbox" name="allowUsernameLookup" ${state.settings.allowUsernameLookup ? 'checked' : ''} />
        </div>
        <div class="form-card form-row">
          <div><strong>Уведомления браузера</strong></div>
          <div class="notification-note">Разрешение: ${'Notification' in window ? Notification.permission : 'не поддерживается'}</div>
          <div class="notification-note muted" id="pushStatusLabel">Push-уведомления (background): проверка…</div>
          <div id="iosPushHint" class="notification-note muted hidden" style="color: #f0ad4e;"></div>
          <div class="inline-actions">
            <button id="enableNotificationsBtn" type="button" class="secondary-btn">Включить уведомления</button>
            <button id="disablePushBtn" type="button" class="secondary-btn hidden">Выключить push на этом устройстве</button>
          </div>
        </div>
        <div class="form-card form-row">
          <div><strong>Данные и синхронизация</strong></div>
          <div class="inline-actions">
            <button id="manageFoldersBtn" type="button" class="secondary-btn">Папки чатов</button>
            <button id="sessionsBtn" type="button" class="secondary-btn">Устройства</button>
            <button id="exportDataBtn" type="button" class="secondary-btn">Экспорт</button>
            <label class="secondary-btn" style="display:inline-flex;align-items:center;gap:8px;cursor:pointer">Импорт<input id="importDataInput" type="file" accept="application/json" style="display:none" /></label>
          </div>
        </div>
        <button class="primary-btn" type="submit">Сохранить настройки</button>
      </form>
    `,
    async (formData) => {
      const result = await api('/api/users/me/settings', {
        method: 'PATCH',
        body: {
          theme: formData.get('theme'),
          compactChats: formData.get('compactChats') === 'on',
          sendOnEnter: formData.get('sendOnEnter') === 'on',
          showPreviews: formData.get('showPreviews') === 'on',
          accentColor: formData.get('accentColor'),
          showFavoriteTab: formData.get('showFavoriteTab') === 'on',
          showArchiveTab: formData.get('showArchiveTab') === 'on',
          phoneVisibility: formData.get('phoneVisibility'),
          lastSeenVisibility: formData.get('lastSeenVisibility'),
          allowUsernameLookup: formData.get('allowUsernameLookup') === 'on'
        }
      });
      state.settings = result.settings;
      closeModal();
      render();
      showToast('Настройки сохранены');
    }
  );
  // === Push: статус и переключение ===
  const pushStatusLabel = document.getElementById('pushStatusLabel');
  const disablePushBtn = document.getElementById('disablePushBtn');
  const iosPushHint = document.getElementById('iosPushHint');
  const refreshPushStatusUI = async () => {
    if (!pushStatusLabel) return;

    // iOS-специфичная подсказка
    if (iosPushHint && typeof isIOSDevice === 'function' && isIOSDevice()) {
      if (typeof isStandalonePWA === 'function' && !isStandalonePWA()) {
        iosPushHint.classList.remove('hidden');
        iosPushHint.textContent = '📱 iOS: Push-уведомления работают только из установленного приложения. ' +
          'Нажмите «Поделиться» → «На экран Домой» в Safari, затем откройте Arena оттуда и включите уведомления.';
      } else {
        iosPushHint.classList.remove('hidden');
        iosPushHint.style.color = '#4da3ff';
        iosPushHint.textContent = '📱 iOS PWA: приложение установлено — push-уведомления поддерживаются.';
      }
    }

    const status = await getPushStatus();
    if (!status.supported) {
      // На iOS в обычном Safari — объясняем почему
      if (typeof isIOSDevice === 'function' && isIOSDevice() && typeof isStandalonePWA === 'function' && !isStandalonePWA()) {
        pushStatusLabel.textContent = 'Push: ⚠️ Установите приложение на экран «Домой» для получения push-уведомлений.';
      } else {
        pushStatusLabel.textContent = 'Push: браузер не поддерживает PushManager.';
      }
      if (disablePushBtn) disablePushBtn.classList.add('hidden');
      return;
    }
    if (status.subscribed) {
      pushStatusLabel.textContent = 'Push: ✅ включены на этом устройстве (приходят даже когда вкладка закрыта).';
      if (disablePushBtn) disablePushBtn.classList.remove('hidden');
    } else if (status.permission === 'denied') {
      pushStatusLabel.textContent = 'Push: ❌ разрешение запрещено в настройках браузера. Разблокируйте уведомления для этого сайта.';
      if (disablePushBtn) disablePushBtn.classList.add('hidden');
    } else {
      pushStatusLabel.textContent = 'Push: ⏸ не подписан. Нажми «Включить уведомления».';
      if (disablePushBtn) disablePushBtn.classList.add('hidden');
    }
  };
  refreshPushStatusUI().catch(() => {});

  const notifyBtn = document.getElementById('enableNotificationsBtn');
  if (notifyBtn) {
    notifyBtn.onclick = async () => {
      notifyBtn.disabled = true;
      try {
        const status = await enablePushNotifications();
        const messages = {
          granted: 'Уведомления и push включены — приходить будут даже когда вкладка закрыта.',
          denied: 'Разрешение запрещено в браузере. Откройте Настройки → Safari → уведомления для этого сайта.',
          default: 'Разрешение не выдано.',
          unsupported: 'Браузер не поддерживает Push API.',
          unconfigured: 'Push не настроен на сервере (нет VAPID-ключей). Обратитесь к администратору.',
          'ios-not-standalone': '📱 На iOS push работает только из установленного приложения. Нажмите «Поделиться» (⎋) → «На экран Домой» в Safari.',
          error: 'Не удалось подписаться. Попробуйте ещё раз.'
        };
        showToast(messages[status] || messages.error, status !== 'granted');
      } finally {
        notifyBtn.disabled = false;
        refreshPushStatusUI().catch(() => {});
      }
    };
  }
  if (disablePushBtn) {
    disablePushBtn.onclick = async () => {
      disablePushBtn.disabled = true;
      try {
        const ok = await disablePushNotifications();
        showToast(ok ? 'Push выключен на этом устройстве' : 'Подписки не было', !ok);
      } finally {
        disablePushBtn.disabled = false;
        refreshPushStatusUI().catch(() => {});
      }
    };
  }
  document.querySelectorAll('.accent-preset').forEach((button) => {
    button.onclick = () => {
      const input = document.getElementById('accentColorInput');
      if (input) input.value = button.dataset.accent;
    };
  });
  const manageFoldersBtn = document.getElementById('manageFoldersBtn');
  if (manageFoldersBtn) manageFoldersBtn.onclick = () => openFoldersModal();
  const sessionsBtn = document.getElementById('sessionsBtn');
  if (sessionsBtn) sessionsBtn.onclick = () => openSessionsModal().catch((error) => showToast(error.message, true));
  const exportBtn = document.getElementById('exportDataBtn');
  if (exportBtn) exportBtn.onclick = () => exportData().catch((error) => showToast(error.message, true));
  const importInput = document.getElementById('importDataInput');
  if (importInput) {
    importInput.onchange = async () => {
      const file = importInput.files?.[0];
      if (!file) return;
      try {
        await importData(file);
        showToast('Данные импортированы');
        openSettingsModal();
      } catch (error) {
        showToast(error.message, true);
      }
    };
  }
}

async function renderMembersManager(chatId, container) {
  const { members } = await api(`/api/chats/${chatId}/members`);
  container.innerHTML = members.map((member) => {
    const canManage = state.currentChat?.viewerRole === 'owner' && member.role !== 'owner';
    const canRemove = ['owner', 'admin'].includes(state.currentChat?.viewerRole) && member.role !== 'owner';
    return `
      <div class="member-row">
        <button type="button" class="member-main user-link" data-profile-id="${member.id}">
          ${avatarMarkup(member.displayName, member.avatarUrl, 'avatar small')}
          <div>
            <div><strong>${escapeHtml(member.displayName)}</strong></div>
            <div class="muted">${member.username ? '@' + escapeHtml(member.username) + ' · ' : ''}${escapeHtml(member.phone || '')}</div>
          </div>
        </button>
        <div class="member-actions">
          <span class="member-role">${escapeHtml(roleLabel(member.role, state.currentChat))}</span>
          ${canManage ? `<button type="button" class="ghost-btn small" data-role-id="${member.id}" data-next-role="${member.role === 'admin' ? 'member' : 'admin'}">${member.role === 'admin' ? 'Сделать участником' : 'Сделать админом'}</button>` : ''}
          ${canManage && member.role === 'admin' ? `<button type="button" class="ghost-btn small" data-permissions-id="${member.id}">Права админа</button>` : ''}
          ${canRemove ? `<button type="button" class="ghost-btn small" data-restrict-id="${member.id}">Мут/Бан</button>` : ''}
          ${canRemove ? `<button type="button" class="ghost-btn small danger-btn" data-remove-id="${member.id}">Удалить</button>` : ''}
        </div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('[data-profile-id]').forEach((button) => {
    button.onclick = () => openUserProfileModal(button.dataset.profileId).catch((error) => showToast(error.message, true));
  });
  container.querySelectorAll('[data-role-id]').forEach((button) => {
    button.onclick = async () => {
      try {
        await api(`/api/chats/${chatId}/members/${button.dataset.roleId}`, { method: 'PATCH', body: { role: button.dataset.nextRole } });
        await refreshChats();
        await renderMembersManager(chatId, container);
      } catch (error) {
        showToast(error.message, true);
      }
    };
  });
  container.querySelectorAll('[data-permissions-id]').forEach((button) => {
    button.onclick = () => {
      const member = members.find((item) => item.id === button.dataset.permissionsId);
      if (!member) return;
      openModal(
        'Права администратора',
        `
          <form class="modal-grid">
            <div class="settings-option">
              <div><strong>Модерация сообщений</strong></div>
              <input class="switch" type="checkbox" name="canManageMessages" ${member.permissions?.canManageMessages ? 'checked' : ''} />
            </div>
            <div class="settings-option">
              <div><strong>Добавление участников</strong></div>
              <input class="switch" type="checkbox" name="canAddMembers" ${member.permissions?.canAddMembers ? 'checked' : ''} />
            </div>
            <div class="settings-option">
              <div><strong>Закрепление сообщений</strong></div>
              <input class="switch" type="checkbox" name="canPinMessages" ${member.permissions?.canPinMessages ? 'checked' : ''} />
            </div>
            <button class="primary-btn" type="submit">Сохранить</button>
          </form>
        `,
        async (formData) => {
          await api(`/api/chats/${chatId}/members/${member.id}`, {
            method: 'PATCH',
            body: {
              role: 'admin',
              canManageMessages: formData.get('canManageMessages') === 'on',
              canAddMembers: formData.get('canAddMembers') === 'on',
              canPinMessages: formData.get('canPinMessages') === 'on'
            }
          });
          closeModal();
          await refreshChats();
          await renderMembersManager(chatId, container);
        }
      );
    };
  });
  container.querySelectorAll('[data-restrict-id]').forEach((button) => {
    button.onclick = () => {
      const member = members.find((item) => item.id === button.dataset.restrictId);
      if (member) openRestrictionModal(member).catch((error) => showToast(error.message, true));
    };
  });
  container.querySelectorAll('[data-remove-id]').forEach((button) => {
    button.onclick = async () => {
      if (!confirm('Удалить участника из чата?')) return;
      try {
        await api(`/api/chats/${chatId}/members/${button.dataset.removeId}`, { method: 'DELETE' });
        await refreshChats();
        await renderMembersManager(chatId, container);
      } catch (error) {
        showToast(error.message, true);
      }
    };
  });
}

async function renderMediaGallery(chatId, container) {
  const { items } = await api(`/api/chats/${chatId}/media`);
  if (!items.length) {
    container.innerHTML = '<div class="muted">Пока нет вложений и ссылок.</div>';
    return;
  }
  const groups = [
    ['photo', 'Фото'],
    ['audio', 'Голосовые и аудио'],
    ['video', 'Видео'],
    ['file', 'Файлы'],
    ['link', 'Ссылки']
  ];
  container.innerHTML = groups.map(([type, title]) => {
    const filtered = items.filter((item) => item.type === type);
    if (!filtered.length) return '';
    return `
      <div class="media-grid">
        <div class="media-type-title">${title}</div>
        ${filtered.map((item) => `
          <div class="member-row">
            <div><strong>${escapeHtml(item.attachmentName || item.url || 'Элемент')}</strong></div>
            <div class="muted">${escapeHtml(item.authorName || '')} · ${formatMessageTime(item.createdAt)}</div>
            ${item.content ? `<div class="muted">${escapeHtml(item.content)}</div>` : ''}
            ${item.type === 'link'
              ? `<a class="file-link" href="${escapeValue(item.url)}" target="_blank" rel="noopener noreferrer">Открыть ссылку</a>`
              : item.type === 'audio'
                ? `<audio class="audio-player" controls ${mediaSourceAttrs(item.attachmentUrl)}></audio><canvas class="audio-waveform" width="220" height="42" data-waveform-src="${escapeValue(item.attachmentUrl)}"></canvas>`
                : item.type === 'photo'
                  ? `<button type="button" class="image-preview-btn"><img class="gallery-image-preview" data-viewer-src="${escapeValue(item.attachmentUrl)}" data-viewer-caption="${escapeValue(item.attachmentName || 'Изображение')}" ${mediaSourceAttrs(item.attachmentUrl)} alt="${escapeValue(item.attachmentName || 'Изображение')}" /></button>`
                  : item.type === 'video'
                    ? `<video class="chat-video-preview" controls preload="metadata" ${mediaSourceAttrs(item.attachmentUrl)}></video>`
                    : ''}
            ${item.attachmentUrl ? `<a class="file-link" ${mediaLinkAttrs(item.attachmentUrl, item.attachmentName || '')}>Открыть</a>` : ''}
          </div>
        `).join('')}
      </div>
    `;
  }).join('');
  mountWaveforms(container);
  hydrateProtectedMedia(container);
}

async function renderInvites(chatId, container) {
  const { invites } = await api(`/api/chats/${chatId}/invites`);
  container.innerHTML = invites.length
    ? invites.map((invite) => `
      <div class="member-row">
        <div><strong>${window.location.origin}/join/${invite.token}</strong></div>
        <div class="muted">Создано: ${formatMessageTime(invite.createdAt)}</div>
        <div class="inline-actions">
          <button type="button" class="secondary-btn copy-invite-btn" data-token="${invite.token}">Скопировать</button>
          <button type="button" class="ghost-btn danger-btn delete-invite-btn" data-token="${invite.token}">Удалить</button>
        </div>
      </div>
    `).join('')
    : '<div class="muted">Пока нет активных ссылок.</div>';

  container.querySelectorAll('.copy-invite-btn').forEach((button) => {
    button.onclick = async () => {
      try {
        await copyText(`${window.location.origin}/join/${button.dataset.token}`);
        showToast('Ссылка скопирована');
      } catch (error) {
        showToast('Не удалось скопировать ссылку', true);
      }
    };
  });
  container.querySelectorAll('.delete-invite-btn').forEach((button) => {
    button.onclick = async () => {
      if (!confirm('Удалить invite link?')) return;
      try {
        await api(`/api/chats/${chatId}/invites/${button.dataset.token}`, { method: 'DELETE' });
        await renderInvites(chatId, container);
      } catch (error) {
        showToast(error.message, true);
      }
    };
  });
}

async function openChatInfoModal(chatId = state.currentChat?.id) {
  if (!chatId) return;
  const { chat } = await api(`/api/chats/${chatId}`);
  state.currentChat = chat;

  if (chat.type === 'private') {
    const peer = chat.peer || {};
    openModal(
      'Информация о диалоге',
      `
        <div class="modal-grid">
          <div class="form-card profile-top">
            ${avatarMarkup(peer.displayName || chat.title, peer.avatarUrl || chat.avatarUrl, 'avatar large')}
            <div class="form-row">
              <div><strong>${escapeHtml(peer.displayName || chat.title || 'Пользователь')}</strong></div>
              <div class="muted">${peer.username ? '@' + escapeHtml(peer.username) : chat.isSaved ? 'Saved Messages' : 'Без username'}</div>
              <div class="muted">${chat.isSaved ? 'Ваше личное пространство для файлов, заметок и пересланных сообщений.' : escapeHtml(peer.phone || '')}</div>
            </div>
          </div>
          <div class="inline-actions">
            ${!chat.isSaved ? '<button id="privateProfileBtn" class="primary-btn">Открыть профиль</button>' : ''}
            <button id="privatePinnedBtn" class="secondary-btn">${chat.pinned ? 'Открепить чат' : 'Закрепить чат'}</button>
            <button id="privateArchiveBtn" class="secondary-btn">${chat.archived ? 'Вернуть из архива' : 'Отправить в архив'}</button>
          </div>
          <div class="form-card form-row">
            <div><strong>Галерея файлов</strong></div>
            <div id="privateMediaBox" class="members-box"><div class="muted">Загрузка...</div></div>
          </div>
        </div>
      `
    );
    if (!chat.isSaved) {
      document.getElementById('privateProfileBtn').onclick = async () => {
        closeModal();
        await openUserProfileModal(peer.id);
      };
    }
    document.getElementById('privatePinnedBtn').onclick = async () => {
      await updateChatPreference(chat, { pinned: !chat.pinned, favorite: chat.favorite, archived: chat.archived });
      closeModal();
    };
    document.getElementById('privateArchiveBtn').onclick = async () => {
      await updateChatPreference(chat, { archived: !chat.archived, favorite: chat.favorite, pinned: chat.pinned });
      closeModal();
    };
    renderMediaGallery(chat.id, document.getElementById('privateMediaBox')).catch((error) => {
      document.getElementById('privateMediaBox').innerHTML = `<div class="muted">${escapeHtml(error.message)}</div>`;
    });
    return;
  }

  openEditorModal(
    chat.type === 'channel' ? 'Настройки канала' : 'Настройки группы',
    `
      <form class="modal-grid">
        <div class="form-card profile-top">
          ${avatarMarkup(chat.title, chat.avatarUrl, 'avatar large')}
          <div class="form-row">
            <div><strong>${escapeHtml(chat.title)}</strong></div>
            <div class="muted">${chat.username ? '@' + escapeHtml(chat.username) : 'Без username'}</div>
            <div>
              <label>Новый аватар</label>
              <input name="avatar" type="file" accept="image/*" />
            </div>
          </div>
        </div>
        <div class="form-card form-row">
          <label>Название</label>
          <input name="title" value="${escapeValue(chat.title || '')}" required />
        </div>
        <div class="form-card form-row">
          <label>Username</label>
          <input name="username" value="${escapeValue(chat.username || '')}" placeholder="chat_username" />
        </div>
        <div class="form-card form-row">
          <label>Описание</label>
          <textarea name="description" rows="4">${escapeValue(chat.description || '')}</textarea>
        </div>
        <div class="form-card form-row">
          <label>Добавить участников по username</label>
          <input name="memberUsernames" placeholder="ivan, news_room" />
        </div>
        <div class="settings-option">
          <div><strong>Участники могут добавлять новых</strong><div class="muted">Если выключено — только админы и владелец.</div></div>
          <input class="switch" type="checkbox" name="membersCanAddMembers" ${chat.restrictions?.membersCanAddMembers ? 'checked' : ''} />
        </div>
        <div class="settings-option">
          <div><strong>Участники могут закреплять сообщения</strong><div class="muted">Полезно для малых рабочих групп.</div></div>
          <input class="switch" type="checkbox" name="membersCanPinMessages" ${chat.restrictions?.membersCanPinMessages ? 'checked' : ''} />
        </div>
        <div class="settings-option">
          <div><strong>Админы могут модерировать чужие сообщения</strong><div class="muted">Редактирование и удаление чужих сообщений.</div></div>
          <input class="switch" type="checkbox" name="adminsCanManageMessages" ${chat.restrictions?.adminsCanManageMessages !== false ? 'checked' : ''} />
        </div>
        ${chat.type === 'channel' ? `<div class=\"settings-option\">\n          <div><strong>Разрешить комментарии к постам</strong><div class=\"muted\">Подписчики смогут комментировать публикации канала.</div></div>\n          <input class=\"switch\" type=\"checkbox\" name=\"commentsEnabled\" ${chat.restrictions?.commentsEnabled ? 'checked' : ''} />\n        </div>` : ''}
        <div class="form-card form-row">
          <div class="inline-actions">
            <button type="button" id="createInviteBtn" class="secondary-btn">Создать invite link</button>
            <button type="button" id="searchMessagesBtn" class="secondary-btn">Поиск по сообщениям</button>
          </div>
        </div>
        <div class="form-card form-row">
          <div><strong>Invite links</strong></div>
          <div id="inviteBox" class="members-box"><div class="muted">Загрузка...</div></div>
        </div>
        <div class="form-card form-row">
          <div><strong>Участники</strong></div>
          <div id="chatMembersBox" class="members-box"><div class="muted">Загрузка...</div></div>
        </div>
        <div class="form-card form-row">
          <div><strong>Галерея файлов</strong></div>
          <div id="chatMediaBox" class="members-box"><div class="muted">Загрузка...</div></div>
        </div>
        <div class="inline-actions">
          <button id="deleteChatInSettingsBtn" type="button" class="ghost-btn danger-btn">${chat.viewerRole === 'owner' ? 'Удалить чат' : 'Покинуть чат'}</button>
        </div>
        <button class="primary-btn" type="submit">Сохранить</button>
      </form>
    `,
    async (formData) => {
      await api(`/api/chats/${chat.id}`, {
        method: 'PATCH',
        body: {
          title: formData.get('title'),
          username: formData.get('username'),
          description: formData.get('description'),
          membersCanAddMembers: formData.get('membersCanAddMembers') === 'on',
          membersCanPinMessages: formData.get('membersCanPinMessages') === 'on',
          adminsCanManageMessages: formData.get('adminsCanManageMessages') === 'on',
          commentsEnabled: formData.get('commentsEnabled') === 'on'
        }
      });
      const memberUsernames = String(formData.get('memberUsernames') || '').split(',').map((item) => item.trim()).filter(Boolean);
      if (memberUsernames.length) {
        await api(`/api/chats/${chat.id}/members`, { method: 'POST', body: { memberUsernames } });
      }
      const avatarFile = formData.get('avatar');
      if (avatarFile && avatarFile.size) {
        const avatarData = new FormData();
        avatarData.append('avatar', avatarFile);
        await api(`/api/chats/${chat.id}/avatar`, { method: 'POST', body: avatarData });
      }
      await refreshChats();
      await openChat(chat.id);
      closeModal();
      showToast('Чат обновлён');
    }
  );

  const membersBox = document.getElementById('chatMembersBox');
  const mediaBox = document.getElementById('chatMediaBox');
  const inviteBox = document.getElementById('inviteBox');
  renderMembersManager(chat.id, membersBox).catch((error) => membersBox.innerHTML = `<div class="muted">${escapeHtml(error.message)}</div>`);
  renderMediaGallery(chat.id, mediaBox).catch((error) => mediaBox.innerHTML = `<div class="muted">${escapeHtml(error.message)}</div>`);
  renderInvites(chat.id, inviteBox).catch((error) => inviteBox.innerHTML = `<div class="muted">${escapeHtml(error.message)}</div>`);
  document.getElementById('deleteChatInSettingsBtn').onclick = async () => {
    if (!confirm(chat.viewerRole === 'owner' ? 'Удалить чат для всех?' : 'Покинуть чат?')) return;
    try {
      await api(`/api/chats/${chat.id}`, { method: 'DELETE' });
      if (state.currentChat?.id === chat.id) state.currentChat = null;
      closeModal();
      await refreshChats();
    } catch (error) {
      showToast(error.message, true);
    }
  };
  document.getElementById('createInviteBtn').onclick = async () => {
    try {
      const result = await api(`/api/chats/${chat.id}/invites`, { method: 'POST' });
      try {
        await copyText(result.url);
        showToast('Invite link создан и скопирован');
      } catch (error) {
        showToast(`Invite link создан: ${result.url}`);
      }
      await renderInvites(chat.id, inviteBox);
    } catch (error) {
      showToast(error.message, true);
    }
  };
  document.getElementById('searchMessagesBtn').onclick = () => openMessageSearchModal(chat.id);
}

function openMessageSearchModal(chatId = null) {
  openModal(
    'Поиск по сообщениям',
    `
      <form class="modal-grid">
        <div class="form-card form-row">
          <label>Текст запроса</label>
          <input name="query" placeholder="Введите текст для поиска" required />
        </div>
        <button class="primary-btn" type="submit">Искать</button>
        <div id="messageSearchResults" class="members-box"></div>
      </form>
    `,
    async (formData) => {
      const { messages } = await api(`/api/chats/search/messages?q=${encodeURIComponent(formData.get('query'))}`);
      const filtered = chatId ? messages.filter((message) => message.chatId === chatId) : messages;
      const box = document.getElementById('messageSearchResults');
      box.innerHTML = filtered.length
        ? filtered.map((message) => `
          <button type="button" class="member-row search-open-message" data-chat-id="${message.chatId}" data-message-id="${message.id}">
            <div><strong>${escapeHtml(message.chatTitle || 'Чат')}</strong></div>
            <div class="muted">${message.chatUsername ? '@' + escapeHtml(message.chatUsername) : ''}</div>
            <div>${escapeHtml(message.content || '')}</div>
            <div class="muted">${formatMessageTime(message.createdAt)}</div>
          </button>
        `).join('')
        : '<div class="muted">Ничего не найдено.</div>';
      box.querySelectorAll('.search-open-message').forEach((button) => {
        button.onclick = async () => {
          closeModal();
          await openChat(button.dataset.chatId);
          setTimeout(() => scrollToMessage(button.dataset.messageId), 300);
        };
      });
    }
  );
}

async function openSavedMessages() {
  const { chat } = await api('/api/chats/saved');
  await refreshChats();
  await openChat(chat.id);
}

async function toggleVoiceRecording() {
  if (!state.currentChat) return;
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    showToast('Запись через браузер недоступна. Выберите аудиофайл вручную.');
    return openAudioFilePicker();
  }
  if (state.mediaRecorder) {
    state.mediaRecorder.stop();
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (error) {
    showToast('Не удалось получить доступ к микрофону. Можно выбрать аудиофайл вручную.', true);
    return openAudioFilePicker();
  }
  const chunks = [];
  
  let mimeType = 'audio/webm';
  const types = ['audio/webm', 'audio/mp4', 'audio/mp3', 'audio/wav'];
  for (const type of types) {
    if (MediaRecorder.isTypeSupported(type)) {
      mimeType = type;
      break;
    }
  }
  
  const recorder = new MediaRecorder(stream, { mimeType });
  state.mediaRecorder = recorder;
  state.recordingStream = stream;
  el.recordVoiceBtn.classList.add('recording');
  el.recordVoiceBtn.textContent = '⏹ Стоп';
  
  recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
  recorder.onstop = async () => {
    const blob = new Blob(chunks, { type: mimeType });
    const ext = mimeType === 'audio/mp4' ? 'mp4' : mimeType === 'audio/mp3' ? 'mp3' : mimeType === 'audio/wav' ? 'wav' : 'webm';
    const formData = new FormData();
    formData.append('content', '');
    formData.append('attachment', new File([blob], `voice-${Date.now()}.${ext}`, { type: mimeType }));
    try {
      await api(`/api/chats/${state.currentChat.id}/messages`, { method: 'POST', body: formData });
      setDraft(state.currentChat.id, '');
      el.messageInput.value = '';
      renderChats();
    } catch (error) {
      showToast(error.message, true);
    } finally {
      state.recordingStream?.getTracks().forEach((track) => track.stop());
      state.mediaRecorder = null;
      state.recordingStream = null;
      el.recordVoiceBtn.classList.remove('recording');
      el.recordVoiceBtn.textContent = '🎤 Голосовое';
    }
  };
  
  recorder.onerror = (event) => {
    showToast(`Ошибка при записи: ${event.error}`, true);
    state.recordingStream?.getTracks().forEach((track) => track.stop());
    state.mediaRecorder = null;
    state.recordingStream = null;
    el.recordVoiceBtn.classList.remove('recording');
    el.recordVoiceBtn.textContent = '🎤 Голосовое';
  };
  
  recorder.start();
}

async function openPrivateDialog() {
  openModal(
    'Новый диалог',
    `
      <form class="modal-grid">
        <div class="form-card form-row">
          <label>Телефон или username</label>
          <input name="query" placeholder="+79991234567 или @username" required />
        </div>
        <button class="primary-btn" type="submit">Открыть диалог</button>
      </form>
    `,
    async (formData) => {
      const raw = String(formData.get('query') || '').trim();
      const payload = raw.startsWith('@') || /[a-zA-Z_]/.test(raw) ? { username: raw } : { phone: raw };
      const { chat } = await api('/api/chats/private', { method: 'POST', body: payload });
      closeModal();
      await refreshChats();
      await openChat(chat.id);
    }
  );
}

function openCreateDialog(type) {
  const title = type === 'channel' ? 'Новый канал' : 'Новая группа';
  openModal(
    title,
    `
      <form class="modal-grid">
        <div class="form-card form-row">
          <label>Название</label>
          <input name="title" placeholder="Введите название" required />
        </div>
        <div class="form-card form-row">
          <label>Username</label>
          <input name="username" placeholder="my_channel" />
        </div>
        <div class="form-card form-row">
          <label>Описание</label>
          <textarea name="description" rows="3" placeholder="Короткое описание"></textarea>
        </div>
        <div class="form-card form-row">
          <label>Username участников через запятую</label>
          <input name="memberUsernames" placeholder="ivan, news_room" />
        </div>
        <button class="primary-btn" type="submit">Создать</button>
      </form>
    `,
    async (formData) => {
      const memberUsernames = String(formData.get('memberUsernames') || '').split(',').map((item) => item.trim()).filter(Boolean);
      const { chat } = await api('/api/chats', {
        method: 'POST',
        body: {
          type,
          title: formData.get('title'),
          username: formData.get('username'),
          description: formData.get('description'),
          memberUsernames
        }
      });
      closeModal();
      await refreshChats();
      await openChat(chat.id);
    }
  );
}

async function openPublicChatModal(publicChat) {
  openModal(
    `@${publicChat.username}`,
    `
      <div class="modal-grid">
        <div class="form-card profile-top">
          ${avatarMarkup(publicChat.title, publicChat.avatarUrl, 'avatar large')}
          <div class="form-row">
            <div><strong>${escapeHtml(publicChat.title)}</strong></div>
            <div class="muted">@${escapeHtml(publicChat.username)}</div>
            <div class="muted">${escapeHtml(chatTypeLabel(publicChat))} · ${publicChat.memberCount} участника(ов)</div>
          </div>
        </div>
        <div class="form-card form-row">
          <label>Описание</label>
          <div>${publicChat.description ? escapeHtml(publicChat.description) : '<span class="muted">Описание не заполнено.</span>'}</div>
        </div>
        <div class="inline-actions">
          <button id="publicJoinBtn" class="primary-btn">${publicChat.isMember ? 'Открыть чат' : joinActionLabel(publicChat.type)}</button>
        </div>
      </div>
    `
  );
  document.getElementById('publicJoinBtn').onclick = async () => {
    try {
      if (publicChat.isMember) {
        const result = await api(`/api/chats/username/${publicChat.username}`);
        closeModal();
        await openChat(result.chat.id);
        return;
      }
      const result = await api(`/api/chats/public/${publicChat.username}/join`, { method: 'POST' });
      closeModal();
      await refreshChats();
      await openChat(result.chat.id);
    } catch (error) {
      showToast(error.message, true);
    }
  };
}

async function openInvitePreviewModal(invite) {
  const chat = invite.chat;
  openModal(
    joinActionLabel(chat.type),
    `
      <div class="modal-grid">
        <div class="form-card profile-top">
          ${avatarMarkup(chat.title, chat.avatarUrl, 'avatar large')}
          <div class="form-row">
            <div><strong>${escapeHtml(chat.title)}</strong></div>
            <div class="muted">${chat.username ? '@' + escapeHtml(chat.username) : chatTypeLabel(chat)}</div>
            <div class="muted">${chat.memberCount} участника(ов)</div>
          </div>
        </div>
        <div class="form-card form-row">
          <label>Описание</label>
          <div>${chat.description ? escapeHtml(chat.description) : '<span class=\"muted\">Описание не заполнено.</span>'}</div>
        </div>
        <div class="inline-actions">
          <button id="joinInviteBtn" class="primary-btn">${chat.isMember ? 'Открыть чат' : joinActionLabel(chat.type)}</button>
        </div>
      </div>
    `
  );
  document.getElementById('joinInviteBtn').onclick = async () => {
    try {
      if (chat.isMember) {
        closeModal();
        await openChat(chat.id);
        return;
      }
      const result = await api(`/api/chats/join/${invite.token}`, { method: 'POST' });
      closeModal();
      await refreshChats();
      await openChat(result.chat.id);
    } catch (error) {
      showToast(error.message, true);
    }
  };
}

async function handleInitialRoute() {
  if (!state.token) return;
  const parts = window.location.pathname.split('/').filter(Boolean);
  if (!parts.length) return;
  try {
    if (parts[0] === 'join' && parts[1]) {
      const result = await api(`/api/chats/join/${parts[1]}`);
      window.history.replaceState({}, '', '/');
      await openInvitePreviewModal(result.invite);
      return;
    }
    if (parts[0] === 'u' && parts[1]) {
      const result = await api(`/api/users/username/${normalizeUsername(parts[1])}`);
      window.history.replaceState({}, '', '/');
      await openUserProfileModal(result.user.id);
      return;
    }
    if ((parts[0] === 'c' || parts[0] === 'g') && parts[1]) {
      const result = await api(`/api/chats/public/${normalizeUsername(parts[1])}`);
      window.history.replaceState({}, '', '/');
      await openPublicChatModal(result.chat);
    }
  } catch (error) {
    window.history.replaceState({}, '', '/');
    showToast(error.message, true);
  }
}

