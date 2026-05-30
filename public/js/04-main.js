/**
 * Axel Messenger — фронтенд, часть 04: connectSocket, bootstrap, stickers, composer, entry-point.
 *
 * До рефакторинга весь клиент жил в одном public/js/app.js на 4134 строки.
 * Теперь он разрезан на 4 файла, которые подключаются строго по порядку
 * (см. <script src='/js/0X-...js'> в public/index.html).
 *
 * Содержит: connectSocket (Socket.IO), openAdminPanel, bootstrap() — точка инициализации приложения. Грузится ПОСЛЕДНИМ — здесь происходит DOMContentLoaded → bootstrap(). До этого все функции должны быть уже определены.
 *
 * ВАЖНО: модуль грузится как обычный <script>, без import/export. Все
 * объявленные тут переменные и функции остаются глобальными — так же,
 * как было в монолите. Это сознательное решение, чтобы рефакторинг
 * был safe-by-default (не меняет ни одной строки логики).
 */

function connectSocket() {
  if (!state.token) return;
  if (state.socket) state.socket.disconnect();
  state.socket = io({ auth: { token: state.token } });

  state.socket.on('connect', () => {
    if (state.currentChat) state.socket.emit('chat:join', { chatId: state.currentChat.id });
  });

  state.socket.on('chats:update', (chats) => {
    state.chats = chats;
    if (state.currentChat) {
      const updated = chats.find((chat) => chat.id === state.currentChat.id);
      if (updated) state.currentChat = { ...state.currentChat, ...updated };
    }
    render();
  });

  state.socket.on('message:new', (message) => {
    const list = normalizeChatMessages(state.messagesByChat[message.chatId] || []);
    if (!message.deletedAt && !list.some((item) => item.id === message.id)) list.push(message);
    state.messagesByChat[message.chatId] = normalizeChatMessages(list);
    if (state.currentChat?.id === message.chatId) {
      requestRenderMessages();
      api(`/api/chats/${message.chatId}/read`, { method: 'POST' }).catch(() => {});
    }
    maybeNotifyMessage(message);
  });

  state.socket.on('message:update', (message) => {
    const list = normalizeChatMessages(state.messagesByChat[message.chatId] || []);
    const index = list.findIndex((item) => item.id === message.id);
    if (message.deletedAt) {
      if (index >= 0) list.splice(index, 1);
    } else if (index >= 0) list[index] = message;
    else list.push(message);
    state.messagesByChat[message.chatId] = normalizeChatMessages(list);
    if (state.currentChat?.id === message.chatId) {
      if (state.currentChat.pinnedMessage?.id === message.id) {
        state.currentChat.pinnedMessage = {
          id: message.id,
          content: message.content,
          attachmentName: message.attachmentName,
          createdAt: message.createdAt
        };
        renderPinnedBar();
      }
      requestRenderMessages();
    }
  });

  // Бэкенд делает hard-delete и эмитит message:deleted. Убираем сообщение из локального стейта,
  // снимаем pin/выделение и перерисовываем.
  state.socket.on('message:deleted', ({ messageId, chatId } = {}) => {
    if (!messageId) return;
    // chatId может не прийти — найдём чат по сообщению
    let targetChatId = chatId;
    if (!targetChatId) {
      for (const [cid, list] of Object.entries(state.messagesByChat)) {
        if (list.some((m) => m.id === messageId)) { targetChatId = cid; break; }
      }
    }
    if (targetChatId && state.messagesByChat[targetChatId]) {
      state.messagesByChat[targetChatId] = state.messagesByChat[targetChatId].filter((m) => m.id !== messageId);
    }
    // Снимаем pin, если это закреплённое
    if (state.currentChat?.pinnedMessage?.id === messageId) {
      state.currentChat.pinnedMessage = null;
      renderPinnedBar();
    }
    // Убираем из выделения, если было выбрано
    if (state.selectedMessageIds.includes(messageId)) {
      state.selectedMessageIds = state.selectedMessageIds.filter((id) => id !== messageId);
      renderSelectionBar();
    }
    if (state.currentChat?.id === targetChatId) {
      requestRenderMessages();
    }
  });

  state.socket.on('chat:pinned', (pinnedMessage) => {
    if (!state.currentChat) return;
    state.currentChat.pinnedMessage = pinnedMessage;
    renderPinnedBar();
  });

  state.socket.on('chat:read', ({ chatId }) => {
    if (state.currentChat?.id === chatId) {
      api(`/api/chats/${chatId}/messages?silent=1`, { method: 'GET' })
        .then((result) => {
          state.messagesByChat[chatId] = normalizeChatMessages(result.messages);
          requestRenderMessages();
        })
        .catch(() => {});
    }
  });

  state.socket.on('typing:update', ({ chatId, userId, displayName, typing }) => {
    if (!state.typingUsers[chatId]) state.typingUsers[chatId] = {};
    if (typing) state.typingUsers[chatId][userId] = displayName;
    else delete state.typingUsers[chatId][userId];
    renderTyping();
  });

  state.socket.on('presence:update', ({ userId, isOnline, at }) => {
    state.presence[userId] = { isOnline, at };
    renderChatHeader();
  });
}


async function openAdminPanel() {
  try {
    const { users, total } = await api('/api/users/admin/users?limit=50');
    
    openModal(
      'Админ-панель - Пользователи',
      `
        <div class="modal-grid">
          <div class="form-card form-row">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <div><strong>Всего пользователей: ${total}</strong></div>
              <input id="adminSearchInput" type="text" placeholder="Поиск..." style="max-width: 200px;" />
            </div>
          </div>
          <div id="adminUsersList" class="members-box" style="max-height: 400px; overflow-y: auto;">
            ${users.map(user => `
              <div class="member-row" data-user-id="${user.id}">
                <button type="button" class="member-main user-link" data-profile-id="${user.id}">
                  ${avatarMarkup(user.displayName, user.avatarUrl, 'avatar small')}
                  <div>
                    <div><strong>${escapeHtml(user.displayName)}</strong> ${user.isSuperadmin ? '<span style="color: #ff6b6b;">[ADMIN]</span>' : ''}</div>
                    <div class="muted">${user.username ? '@' + escapeHtml(user.username) + ' · ' : ''}${escapeHtml(user.phone || '')}</div>
                    <div class="muted">Чатов: ${user.chatsCount} · Сообщений: ${user.messagesCount} · Жалоб: ${user.reportsCount}</div>
                  </div>
                </button>
                <div class="member-actions">
                  <button type="button" class="ghost-btn small" data-admin-action="edit" data-user-id="${user.id}">Изменить</button>
                  <button type="button" class="ghost-btn small danger-btn" data-admin-action="block" data-user-id="${user.id}">Блок</button>
                  <button type="button" class="ghost-btn small danger-btn" data-admin-action="delete" data-user-id="${user.id}">Удалить</button>
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      `
    );
    
    // Обработчики
    document.querySelectorAll('[data-admin-action="edit"]').forEach(btn => {
      btn.onclick = async () => {
        const userId = btn.dataset.userId;
        const user = users.find(u => u.id === userId);
        openModal('Редактировать пользователя', `
          <form class="modal-grid">
            <div class="form-card form-row">
              <label>Имя</label>
              <input name="displayName" value="${escapeValue(user.displayName)}" />
            </div>
            <div class="form-card form-row">
              <label>Username</label>
              <input name="username" value="${escapeValue(user.username || '')}" />
            </div>
            <div class="form-card form-row">
              <label>О себе</label>
              <textarea name="bio" rows="3">${escapeValue(user.bio || '')}</textarea>
            </div>
            <div class="settings-option">
              <div><strong>Супер-админ</strong></div>
              <input class="switch" type="checkbox" name="isSuperadmin" ${user.isSuperadmin ? 'checked' : ''} />
            </div>
            <button class="primary-btn" type="submit">Сохранить</button>
          </form>
        `, async (formData) => {
          await api(`/api/users/admin/users/${userId}`, {
            method: 'PATCH',
            body: {
              displayName: formData.get('displayName'),
              username: formData.get('username'),
              bio: formData.get('bio'),
              isSuperadmin: formData.get('isSuperadmin') === 'on'
            }
          });
          closeModal();
          showToast('Пользователь обновлен');
          openAdminPanel();
        });
      };
    });
    
    document.querySelectorAll('[data-admin-action="block"]').forEach(btn => {
      btn.onclick = async () => {
        if (!confirm('Заблокировать пользователя во всех чатах?')) return;
        await api(`/api/users/admin/users/${btn.dataset.userId}/block`, {
          method: 'POST',
          body: { reason: 'Блокировка администратором', duration: null }
        });
        showToast('Пользователь заблокирован');
      };
    });
    
    document.querySelectorAll('[data-admin-action="delete"]').forEach(btn => {
      btn.onclick = async () => {
        if (!confirm('Удалить аккаунт пользователя? Это действие нельзя отменить!')) return;
        const hardDelete = confirm('Полное удаление из БД? (ОК = да, Отмена = мягкое удаление)');
        await api(`/api/users/admin/users/${btn.dataset.userId}`, {
          method: 'DELETE',
          body: { hardDelete }
        });
        showToast('Пользователь удален');
        openAdminPanel();
      };
    });
    
    // Поиск
    const searchInput = document.getElementById('adminSearchInput');
    if (searchInput) {
      searchInput.oninput = async () => {
        const query = searchInput.value.trim();
        if (query.length < 2) return;
        const result = await api(`/api/users/admin/users?search=${encodeURIComponent(query)}&limit=50`);
        document.getElementById('adminUsersList').innerHTML = result.users.map(user => `
          <div class="member-row">
            <div><strong>${escapeHtml(user.displayName)}</strong> ${user.username ? '@' + escapeHtml(user.username) : ''}</div>
          </div>
        `).join('');
      };
    }
    
  } catch (error) {
    showToast(error.message, true);
  }
}

async function bootstrap() {
  if (!state.token) return render();
  try {
    const { user } = await api('/api/auth/me');
    updateStoredUser(user);
    await loadSettings();
    await loadDrafts();
    await loadFolders();
    await refreshChats({ showSkeleton: true });
    connectSocket();
    await handleInitialRoute();
    // Регистрируем Service Worker — нужен для PWA cache, offline и push.
    if (typeof ensureServiceWorker === 'function') {
      ensureServiceWorker().then((reg) => {
        if (!reg) return;
        // iOS Safari может отзывать push-подписку при каждом перезапуске PWA.
        // Поэтому при каждом старте БЕЗУСЛОВНО переподписываемся, если
        // permission уже 'granted'. enablePushNotifications() идемпотентна —
        // PushManager.subscribe() вернёт существующую подписку если endpoint
        // не изменился, а POST /push-subscriptions — upsert по endpoint.
        if (typeof enablePushNotifications === 'function' && 'Notification' in window && Notification.permission === 'granted') {
          enablePushNotifications().catch(() => {});
        }
      }).catch(() => {});
    }
  } catch (error) {
    clearSession();
    showToast('Сессия истекла. Войдите снова.', true);
  }
  render();
}

el.requestCodeBtn.onclick = async () => {
  try {
    const result = await api('/api/auth/request-code', { method: 'POST', body: { phone: el.phoneInput.value.trim() } });
    state.authUserExists = result.userExists;
    el.codeStep.classList.remove('hidden');
    el.displayNameInput.value = '';
    el.displayNameStep.classList.toggle('hidden', result.userExists);
    el.authModeHint.textContent = result.userExists ? 'Номер уже зарегистрирован — просто введите код.' : 'Новый номер: укажите имя только для первой регистрации.';
    el.devCodeHint.textContent = result.devCode ? `Тестовый код: ${result.devCode}` : 'Код отправлен.';
    // Снимаем подсветку с кнопки бота — она здесь не нужна
    document.getElementById('botLinkBtn')?.classList.remove('needs-binding');
    showToast('Код отправлен');
  } catch (error) {
    // Особый случай: нужно сначала привязать номер в Telegram-боте
    if (error.data?.code === 'NEEDS_BINDING') {
      const botLink = document.getElementById('botLinkBtn');
      if (botLink) {
        // Если сервер прислал актуальный username бота — обновим ссылку
        if (error.data.botUsername) {
          botLink.href = `https://t.me/${error.data.botUsername}`;
        }
        botLink.classList.add('needs-binding');
        botLink.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      el.codeStep.classList.add('hidden');
      el.authModeHint.innerHTML = '⚠️ Сначала откройте Telegram-бота и нажмите <b>«📱 Отправить номер»</b>, а затем вернитесь сюда и снова нажмите «Получить код».';
      el.devCodeHint.textContent = '';
      showToast(error.message, true);
      return;
    }
    if (error.data?.code === 'NO_DELIVERY') {
      el.authModeHint.textContent = '⚠️ Сервис отправки кодов сейчас недоступен. Попробуйте позже или свяжитесь с поддержкой.';
      showToast(error.message, true);
      return;
    }
    if (error.data?.code === 'TELEGRAM_FAIL') {
      el.authModeHint.textContent = '⚠️ Не удалось отправить код через Telegram. Попробуйте ещё раз через минуту.';
      showToast(error.message, true);
      return;
    }
    showToast(error.message, true);
  }
};

el.loginBtn.onclick = async () => {
  try {
    const body = { phone: el.phoneInput.value.trim(), code: el.codeInput.value.trim() };
    if (state.authUserExists === false) body.displayName = el.displayNameInput.value.trim();
    const result = await api('/api/auth/verify-code', { method: 'POST', body });
    saveSession(result.token, result.user);
    resetAuthForm();
    await loadSettings();
    await loadDrafts();
    await loadFolders();
    await refreshChats({ showSkeleton: true });
    connectSocket();
    await handleInitialRoute();
    render();
    showToast(result.isNewUser ? 'Регистрация завершена' : 'Вы вошли в систему');
  } catch (error) {
    showToast(error.message, true);
  }
};

el.closeModalBtn.onclick = closeModal;
el.modal.onclick = (event) => { if (event.target === el.modal) closeModal(); };
document.addEventListener('click', (event) => {
  if (!event.target.closest('.message-tools')) {
    document.querySelectorAll('.reaction-picker').forEach((node) => node.classList.add('hidden'));
  }
  if (!event.target.closest('.context-menu')) closeContextMenu();
  const image = event.target.closest('[data-viewer-src]');
  if (image) {
    event.preventDefault();
    openImageViewerFromSrc(image.dataset.viewerSrc);
  }
});

el.menuToggleBtn.onclick = () => (state.drawerOpen ? closeDrawer() : openDrawer());
el.drawerOverlay.onclick = () => closeDrawer();
el.mobileToolsBtn.onclick = () => toggleMobileTools();
el.mobileToolsOverlay.onclick = () => closeMobileTools();
el.quickSettingsBtn.onclick = openSettingsModal;
el.closeImageViewerBtn.onclick = closeImageViewer;
el.imageViewer.onclick = (event) => { if (event.target === el.imageViewer) closeImageViewer(); };
el.imageViewer.addEventListener('touchstart', (event) => {
  el.imageViewer.dataset.touchStartX = String(event.changedTouches[0]?.clientX || 0);
}, { passive: true });
el.imageViewer.addEventListener('touchend', (event) => {
  const startX = Number(el.imageViewer.dataset.touchStartX || 0);
  const endX = Number(event.changedTouches[0]?.clientX || 0);
  const delta = endX - startX;
  if (Math.abs(delta) < 40) return;
  shiftImageViewer(delta > 0 ? -1 : 1);
}, { passive: true });
el.prevImageBtn.onclick = () => shiftImageViewer(-1);
el.nextImageBtn.onclick = () => shiftImageViewer(1);
el.chatSearchBtn.onclick = () => openMessageSearchModal(state.currentChat?.id);
el.bulkSelectBtn.onclick = () => {
  state.selectMode = !state.selectMode;
  if (!state.selectMode) state.selectedMessageIds = [];
  render();
};
el.chatInfoBtn.onclick = () => openChatInfoModal().catch((error) => showToast(error.message, true));
el.mobileBackBtn.onclick = () => {
  if (!isMobileViewport()) return;
  state.currentChat = null;
  closeMobileTools();
  syncMobileLayout();
  render();
};

el.chatHeaderProfileBtn.onclick = () => {
  if (!state.currentChat) return;
  if (state.currentChat.type === 'private' && state.currentChat.peer?.id) {
    openUserProfileModal(state.currentChat.peer.id).catch((error) => showToast(error.message, true));
  } else {
    openChatInfoModal().catch((error) => showToast(error.message, true));
  }
};

[el.newChatBtn, el.drawerNewChatBtn].forEach((button) => button.onclick = () => { closeDrawer(); openPrivateDialog(); });
[el.newGroupBtn, el.drawerNewGroupBtn].forEach((button) => button.onclick = () => { closeDrawer(); openCreateDialog('group'); });
[el.newChannelBtn, el.drawerNewChannelBtn].forEach((button) => button.onclick = () => { closeDrawer(); openCreateDialog('channel'); });

el.drawerProfileBtn.onclick = () => { closeDrawer(); openProfileModal(); };
el.drawerSettingsBtn.onclick = () => { closeDrawer(); openSettingsModal(); };
el.drawerModerationBtn.onclick = () => { openModerationChat().catch((error) => showToast(error.message, true)); };
el.drawerSavedBtn.onclick = () => { closeDrawer(); openSavedMessages().catch((error) => showToast(error.message, true)); };
el.drawerSearchMessagesBtn.onclick = () => { closeDrawer(); openMessageSearchModal(); };
el.drawerFoldersBtn.onclick = () => { closeDrawer(); openFoldersModal(); };
el.drawerFavoritesBtn.onclick = () => {
  // Кнопка "Избранное" в меню тоже ведёт в чат "Избранное" (Saved Messages),
  // а не в фильтр по избранным чатам.
  closeDrawer();
  openSavedMessages().catch((error) => showToast(error.message, true));
};
el.drawerArchiveBtn.onclick = () => { state.chatFilter = 'archive'; closeDrawer(); render(); };
el.drawerLogoutBtn.onclick = async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  clearSession();
};

el.chatFilters.onclick = (event) => {
  const button = event.target.closest('[data-filter]');
  if (!button) return;
  // Специальное поведение для "Избранное" — открываем чат с самим собой
  // (Saved Messages), а не фильтр по чатам, помеченным как избранные.
  if (button.dataset.filter === 'saved') {
    // Снимаем активность с других чипов и выделяем этот.
    el.chatFilters.querySelectorAll('[data-filter]').forEach((node) => node.classList.remove('active'));
    button.classList.add('active');
    openSavedMessages()
      .catch((error) => showToast(error.message, true))
      .finally(() => {
        // После открытия чата возвращаем фильтр списка к "Все",
        // чтобы пользователь видел все чаты, а не только Saved.
        const allChip = el.chatFilters.querySelector('[data-filter="all"]');
        if (allChip) {
          el.chatFilters.querySelectorAll('[data-filter]').forEach((node) => node.classList.remove('active'));
          allChip.classList.add('active');
        }
        state.chatFilter = 'all';
        render();
      });
    return;
  }
  state.chatFilter = button.dataset.filter;
  render();
};

el.globalSearchInput.addEventListener('input', () => {
  state.searchQuery = el.globalSearchInput.value;
  renderChats();
  renderSearchResults();
  clearTimeout(el.globalSearchInput._timer);
  el.globalSearchInput._timer = setTimeout(() => searchUsers(state.searchQuery), 220);
});

let typingTimer = null;
el.messageInput.addEventListener('input', () => {
  if (!state.currentChat) return;
  setDraft(state.currentChat.id, el.messageInput.value);
  state.socket?.emit('typing:start', { chatId: state.currentChat.id });
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => state.socket?.emit('typing:stop', { chatId: state.currentChat.id }), 1200);
});

function openEmojiPicker() {
  openModal('Emoji', `<div class="emoji-grid">${EMOJI_SET.map((emoji) => `<button type="button" class="emoji-btn" data-emoji="${emoji}">${emoji}</button>`).join('')}</div>`);
  document.querySelectorAll('.emoji-btn').forEach((button) => {
    button.onclick = () => {
      insertAtCursor(button.dataset.emoji);
      closeModal();
    };
  });
}

const STICKER_PACKS = [
  { id: 'classic', title: 'Classic', stickers: ['🐸','🐱','🐼','🦊','🐵','🐻','🦄','🐙'] },
  { id: 'party', title: 'Party', stickers: ['🎉','🚀','✨','💥','🔥','❤️','🥳','💯'] },
  { id: 'food', title: 'Food', stickers: ['🍕','☕','🍔','🍩','🍉','🍓','🍰','🥐'] }
];

function renderStickerPack(packId = STICKER_PACKS[0].id) {
  const pack = STICKER_PACKS.find((item) => item.id === packId) || STICKER_PACKS[0];
  const tabs = STICKER_PACKS.map((item) => `<button type="button" class="filter-chip sticker-pack-tab ${item.id === pack.id ? 'active' : ''}" data-pack-id="${item.id}">${item.title}</button>`).join('');
  return `
    <div class="modal-grid">
      <div class="chat-filters">${tabs}</div>
      <div class="sticker-grid">${pack.stickers.map((sticker) => `<button type="button" class="sticker-btn" data-sticker="${sticker}">${sticker}</button>`).join('')}</div>
    </div>
  `;
}

function bindStickerPackEvents() {
  document.querySelectorAll('.sticker-pack-tab').forEach((button) => {
    button.onclick = () => {
      const body = document.getElementById('modalBody');
      body.innerHTML = renderStickerPack(button.dataset.packId);
      bindStickerPackEvents();
    };
  });
  document.querySelectorAll('.sticker-btn').forEach((button) => {
    button.onclick = async () => {
      try {
        await sendSticker(button.dataset.sticker);
        closeModal();
      } catch (error) {
        showToast(error.message, true);
      }
    };
  });
}

function openStickerPicker() {
  openModal('Стикеры', renderStickerPack());
  bindStickerPackEvents();
}

el.attachBtn.onclick = () => {
  closeMobileTools();
  if (isMobileViewport()) {
    const html = `
      <div style="display: grid; gap: 10px;">
        <button type="button" class="primary-btn" id="galleryBtn">🖼️ Выбрать из галереи</button>
        <button type="button" class="secondary-btn" id="cameraBtn">📷 Фото с камеры</button>
        <button type="button" class="secondary-btn" id="videoBtn">🎥 Видео с камеры</button>
        <button type="button" class="secondary-btn" id="filesBtn">📎 Другие файлы</button>
      </div>
    `;
    openModal('Загрузить', html);
    document.getElementById('cameraBtn').onclick = () => {
      closeModal();
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.capture = 'environment';
      input.click();
      input.onchange = () => {
        if (input.files?.length) addPendingFiles(Array.from(input.files));
      };
    };
    document.getElementById('videoBtn').onclick = () => {
      closeModal();
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'video/*';
      input.capture = 'environment';
      input.click();
      input.onchange = () => {
        if (input.files?.length) addPendingFiles(Array.from(input.files));
      };
    };
    document.getElementById('galleryBtn').onclick = () => {
      closeModal();
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*,video/*';
      input.multiple = true;
      input.click();
      input.onchange = () => {
        if (input.files?.length) addPendingFiles(Array.from(input.files));
      };
    };
    document.getElementById('filesBtn').onclick = () => {
      closeModal();
      el.fileInput.click();
    };
  } else {
    el.fileInput.click();
  }
};
// Мобильная attach-кнопка ведёт себя так же, как основная
if (el.attachBtnMobile) el.attachBtnMobile.onclick = el.attachBtn.onclick;
[el.attachBtn, el.attachBtnMobile, el.emojiBtn, el.stickerBtn, el.recordVoiceBtn, el.sendBtn, el.mobileToolsBtn].filter(Boolean).forEach((button) => {
  button.addEventListener('mouseenter', () => button.classList.add('button-preview-glow'));
  button.addEventListener('mouseleave', () => button.classList.remove('button-preview-glow'));
  button.addEventListener('focus', () => button.classList.add('button-preview-glow'));
  button.addEventListener('blur', () => button.classList.remove('button-preview-glow'));
});
el.emojiBtn.onclick = () => { closeMobileTools(); openEmojiPicker(); };
el.stickerBtn.onclick = () => { closeMobileTools(); openStickerPicker(); };
el.recordVoiceBtn.onclick = () => { closeMobileTools(); toggleVoiceRecording().catch((error) => showToast(error.message, true)); };

el.fileInput.addEventListener('change', () => { if (isMobileViewport()) closeMobileTools(); addPendingFiles(Array.from(el.fileInput.files || [])); });

el.sendBtn.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  openSendContextMenu(event.clientX, event.clientY);
});
let sendPressTimer = null;
el.sendBtn.addEventListener('touchstart', (event) => {
  if (!isMobileViewport()) return;
  const touch = event.changedTouches?.[0];
  if (!touch) return;
  state.sendLongPressTriggered = false;
  sendPressTimer = setTimeout(() => {
    state.sendLongPressTriggered = true;
    openSendContextMenu(touch.clientX, touch.clientY);
  }, 420);
}, { passive: true });
['touchend', 'touchcancel', 'touchmove'].forEach((name) => {
  el.sendBtn.addEventListener(name, () => {
    if (sendPressTimer) {
      clearTimeout(sendPressTimer);
      sendPressTimer = null;
    }
  }, { passive: true });
});
el.sendBtn.addEventListener('click', (event) => {
  if (state.sendLongPressTriggered) {
    event.preventDefault();
    event.stopPropagation();
    state.sendLongPressTriggered = false;
  }
});

el.messageInput.addEventListener('keydown', (event) => {
  if (!state.settings.sendOnEnter) return;
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    el.composer.requestSubmit();
  }
});

async function submitComposer(fileOverride = null) {
  if (!state.currentChat) return;
  const files = fileOverride ? (Array.isArray(fileOverride) ? fileOverride : [fileOverride]) : state.pendingFiles.map((item) => item.file);
  const content = el.messageInput.value.trim();
  if (!content && !files.length) {
    showToast('Сообщение пустое', true);
    return;
  }
  if (!files.length) {
    const formData = new FormData();
    formData.append('content', content);
    if (state.replyTo) formData.append('replyToMessageId', state.replyTo.id);
    await api(`/api/chats/${state.currentChat.id}/messages`, { method: 'POST', body: formData });
  } else {
    const preparedFiles = [];
    for (const file of files) {
      preparedFiles.push(await compressImageFile(file));
    }
    const formData = new FormData();
    formData.append('content', content);
    if (state.replyTo) formData.append('replyToMessageId', state.replyTo.id);
    preparedFiles.forEach((file) => formData.append('attachment', file));
    await api(`/api/chats/${state.currentChat.id}/messages`, { method: 'POST', body: formData });
  }
  el.messageInput.value = '';
  el.fileInput.value = '';
  clearPendingFiles();
  setDraft(state.currentChat.id, '');
  state.replyTo = null;
  renderReplyBox();
  updateChatListItem(state.currentChat.id);
  state.socket?.emit('typing:stop', { chatId: state.currentChat.id });
}

el.composer.onsubmit = async (event) => {
  event.preventDefault();
  try {
    await submitComposer();
  } catch (error) {
    showToast(error.message, true);
  }
};

['dragenter','dragover'].forEach((name) => {
  el.chatPanel.addEventListener(name, (event) => {
    if (!state.currentChat) return;
    event.preventDefault();
    el.chatPanel.classList.add('drag-over');
  });
});
['dragleave','dragend','drop'].forEach((name) => {
  el.chatPanel.addEventListener(name, () => el.chatPanel.classList.remove('drag-over'));
});
el.chatPanel.addEventListener('drop', async (event) => {
  if (!state.currentChat) return;
  event.preventDefault();
  const files = Array.from(event.dataTransfer?.files || []);
  if (!files.length) return;
  addPendingFiles(files);
  showToast(files.length > 1 ? `Добавлено файлов: ${files.length}` : 'Файл добавлен в превью');
});

window.addEventListener('keydown', (event) => {
  if (el.imageViewer.classList.contains('hidden')) return;
  if (event.key === 'Escape') closeImageViewer();
  if (event.key === 'ArrowLeft') shiftImageViewer(-1);
  if (event.key === 'ArrowRight') shiftImageViewer(1);
});

// На мобиле адресная строка браузера постоянно триггерит resize.
// Полный render() на каждый такой resize = мигание/дёргание интерфейса.
// Поэтому перерисовываем только когда реально меняется breakpoint или ориентация.
let __lastMobileMode = isMobileViewport();
let __resizeTimer = null;
window.addEventListener('resize', () => {
  if (__resizeTimer) clearTimeout(__resizeTimer);
  __resizeTimer = setTimeout(() => {
    const nextMobileMode = isMobileViewport();
    const crossedBreakpoint = nextMobileMode !== __lastMobileMode;
    __lastMobileMode = nextMobileMode;
    syncMobileLayout();
    if (crossedBreakpoint || !nextMobileMode) {
      render();
    }
  }, 140);
});
window.addEventListener('orientationchange', () => {
  setTimeout(() => {
    __lastMobileMode = isMobileViewport();
    syncMobileLayout();
    render();
  }, 180);
});

// ===================================================================
// Pull-to-refresh (мобильный свайп вниз для обновления чатов)
// ===================================================================
(function initPullToRefresh() {
  if (!('ontouchstart' in window)) return;
  let startY = 0;
  let pulling = false;
  let indicator = null;

  function getIndicator() {
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.style.cssText = 'position:fixed;top:0;left:0;right:0;height:3px;background:var(--primary);z-index:9999;transform:scaleX(0);transform-origin:left;transition:transform 0.2s;';
      document.body.appendChild(indicator);
    }
    return indicator;
  }

  const chatList = document.getElementById('chatList');
  if (!chatList) return;

  chatList.addEventListener('touchstart', (e) => {
    if (chatList.scrollTop <= 0) {
      startY = e.touches[0].clientY;
      pulling = true;
    }
  }, { passive: true });

  chatList.addEventListener('touchmove', (e) => {
    if (!pulling) return;
    const dy = e.touches[0].clientY - startY;
    if (dy > 10 && dy < 150) {
      getIndicator().style.transform = 'scaleX(' + Math.min(1, dy / 100) + ')';
    }
  }, { passive: true });

  chatList.addEventListener('touchend', (e) => {
    if (!pulling) return;
    const dy = (e.changedTouches[0]?.clientY || 0) - startY;
    pulling = false;
    const ind = getIndicator();
    if (dy > 80) {
      ind.style.transform = 'scaleX(1)';
      if (typeof refreshChats === 'function') {
        refreshChats().finally(() => {
          setTimeout(() => { ind.style.transform = 'scaleX(0)'; }, 300);
        });
      } else {
        window.location.reload();
      }
    } else {
      ind.style.transform = 'scaleX(0)';
    }
    startY = 0;
  }, { passive: true });
})();

bootstrap();
