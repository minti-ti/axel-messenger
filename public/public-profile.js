function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function initials(value) {
  return String(value || 'U')
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
  const box = document.getElementById('publicProfileBox');
  const username = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');
  try {
    const response = await fetch(`/api/public/users/${encodeURIComponent(username)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Профиль недоступен');
    const user = data.user;
    box.innerHTML = `
      <div class="form-card profile-top">
        ${avatar(user.displayName, user.avatarUrl)}
        <div class="form-row">
          <div><strong>${escapeHtml(user.displayName)}</strong></div>
          <div class="muted">@${escapeHtml(user.username || username)}</div>
          <div class="muted">${user.phone ? escapeHtml(user.phone) : 'Телефон скрыт'}</div>
          <div class="muted">${user.isOnline ? 'В сети' : user.lastSeen ? `Был(а) в сети ${new Date(user.lastSeen).toLocaleString('ru-RU')}` : 'Недавно был(а) в сети'}</div>
        </div>
      </div>
      <div class="form-card form-row">
        <label>О себе</label>
        <div>${user.bio ? escapeHtml(user.bio) : '<span class="muted">Пользователь пока ничего не рассказал о себе.</span>'}</div>
      </div>
    `;
  } catch (error) {
    box.innerHTML = `<div class="form-card form-row"><strong>Ошибка</strong><div class="muted">${escapeHtml(error.message)}</div></div>`;
  }
}

bootstrap();
