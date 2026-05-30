function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function initials(value) {
  return String(value || 'C')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
}

function avatar(name, url) {
  return url
    ? `<div class="avatar large"><img src="${escapeHtml(url)}" alt="${escapeHtml(name)}" /></div>`
    : `<div class="avatar large">${escapeHtml(initials(name))}</div>`;
}

async function bootstrap() {
  const box = document.getElementById('publicChatBox');
  const username = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');
  try {
    const response = await fetch(`/api/public/chats/${encodeURIComponent(username)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Чат недоступен');
    const chat = data.chat;
    box.innerHTML = `
      <div class="form-card profile-top">
        ${avatar(chat.title, chat.avatarUrl)}
        <div class="form-row">
          <div><strong>${escapeHtml(chat.title)}</strong></div>
          <div class="muted">@${escapeHtml(chat.username || username)}</div>
          <div class="muted">${escapeHtml(chat.type === 'channel' ? 'Канал' : 'Группа')} · ${chat.memberCount} участника(ов)</div>
          <div class="muted">Владелец: ${escapeHtml(chat.ownerDisplayName || chat.ownerUsername || 'не указан')}</div>
        </div>
      </div>
      <div class="form-card form-row">
        <label>Описание</label>
        <div>${chat.description ? escapeHtml(chat.description) : '<span class="muted">Описание пока не заполнено.</span>'}</div>
      </div>
      <div class="form-card form-row">
        <div class="muted">Чтобы вступить или открыть этот чат, войдите в Axel Messenger.</div>
      </div>
    `;
  } catch (error) {
    box.innerHTML = `<div class="form-card form-row"><strong>Ошибка</strong><div class="muted">${escapeHtml(error.message)}</div></div>`;
  }
}

bootstrap();
