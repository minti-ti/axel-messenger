function normalizePhone(input) {
  const digits = String(input || '').replace(/[^\d+]/g, '');
  if (!digits) return '';
  if (digits.startsWith('+')) return digits;
  if (digits.startsWith('8') && digits.length === 11) return `+7${digits.slice(1)}`;
  if (digits.startsWith('7') && digits.length === 11) return `+${digits}`;
  return digits.startsWith('+') ? digits : `+${digits}`;
}

function normalizeUsername(input) {
  const value = String(input || '').trim().replace(/^@+/, '').toLowerCase();
  if (!value) return '';
  return value;
}

function isValidUsername(input) {
  return /^[a-z0-9_]{4,32}$/.test(String(input || ''));
}

function makeCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function formatPublicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    phone: user.phone,
    username: user.username,
    displayName: user.display_name,
    avatarUrl: user.avatar_url,
    bio: user.bio,
    isSuperadmin: Boolean(user.is_superadmin),
    createdAt: user.created_at,
    lastSeen: user.last_seen
  };
}

module.exports = {
  normalizePhone,
  normalizeUsername,
  isValidUsername,
  makeCode,
  formatPublicUser
};
