CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  phone TEXT UNIQUE NOT NULL,
  username TEXT,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  bio TEXT DEFAULT '',
  is_superadmin BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS login_codes (
  phone TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('private', 'group', 'channel')),
  title TEXT,
  username TEXT,
  description TEXT DEFAULT '',
  avatar_url TEXT,
  owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  pinned_message_id TEXT,
  is_public BOOLEAN NOT NULL DEFAULT FALSE,
  members_can_add_members BOOLEAN NOT NULL DEFAULT FALSE,
  members_can_pin_messages BOOLEAN NOT NULL DEFAULT FALSE,
  admins_can_manage_messages BOOLEAN NOT NULL DEFAULT TRUE,
  comments_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chat_members (
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  muted BOOLEAN NOT NULL DEFAULT FALSE,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  favorite BOOLEAN NOT NULL DEFAULT FALSE,
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  can_manage_messages BOOLEAN NOT NULL DEFAULT TRUE,
  can_add_members BOOLEAN NOT NULL DEFAULT TRUE,
  can_pin_messages BOOLEAN NOT NULL DEFAULT TRUE,
  muted_until TIMESTAMPTZ,
  mute_reason TEXT,
  banned_until TIMESTAMPTZ,
  ban_reason TEXT,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chat_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT DEFAULT '',
  is_encrypted BOOLEAN NOT NULL DEFAULT FALSE,
  encryption_key_version INTEGER DEFAULT 1,
  message_type TEXT NOT NULL DEFAULT 'text' CHECK (message_type IN ('text', 'file', 'system')),
  attachment_url TEXT,
  attachment_name TEXT,
  reply_to_message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  forwarded_from_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  forwarded_from_message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  album_id TEXT,
  report_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  edited_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS reactions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  theme TEXT NOT NULL DEFAULT 'dark' CHECK (theme IN ('dark', 'light', 'telegram')),
  compact_chats BOOLEAN NOT NULL DEFAULT FALSE,
  send_on_enter BOOLEAN NOT NULL DEFAULT TRUE,
  show_previews BOOLEAN NOT NULL DEFAULT TRUE,
  accent_color TEXT NOT NULL DEFAULT '#4da3ff',
  show_favorite_tab BOOLEAN NOT NULL DEFAULT TRUE,
  show_archive_tab BOOLEAN NOT NULL DEFAULT TRUE,
  phone_visibility TEXT NOT NULL DEFAULT 'everyone',
  last_seen_visibility TEXT NOT NULL DEFAULT 'everyone',
  allow_username_lookup BOOLEAN NOT NULL DEFAULT TRUE,
  notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  notify_mentions BOOLEAN NOT NULL DEFAULT TRUE,
  notify_private_chats BOOLEAN NOT NULL DEFAULT TRUE,
  notify_groups BOOLEAN NOT NULL DEFAULT TRUE,
  notify_sound BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chat_invites (
  id TEXT PRIMARY KEY,
  token TEXT UNIQUE NOT NULL,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_drafts (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  content TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, chat_id)
);

CREATE TABLE IF NOT EXISTS user_reports (
  id TEXT PRIMARY KEY,
  reporter_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reported_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  details TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewing','resolved','dismissed')),
  resolution_note TEXT DEFAULT '',
  moderation_message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT DEFAULT '',
  user_agent TEXT DEFAULT '',
  ip_address TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS scheduled_messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL DEFAULT '',
  reply_to_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  attachment_url TEXT,
  attachment_name TEXT,
  scheduled_for TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS user_folders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_folder_chats (
  folder_id TEXT NOT NULL REFERENCES user_folders(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  PRIMARY KEY (folder_id, chat_id)
);

CREATE TABLE IF NOT EXISTS encryption_keys (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  key_data TEXT NOT NULL,
  algorithm TEXT NOT NULL DEFAULT 'AES-256-GCM',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(chat_id, version)
);

CREATE TABLE IF NOT EXISTS message_deletion_logs (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  deleted_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  scrubbed BOOLEAN NOT NULL DEFAULT FALSE
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_superadmin BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS pinned_message_id TEXT;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS members_can_add_members BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS members_can_pin_messages BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS admins_can_manage_messages BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS comments_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE chat_members ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE chat_members ADD COLUMN IF NOT EXISTS favorite BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE chat_members ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE chat_members ADD COLUMN IF NOT EXISTS can_manage_messages BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE chat_members ADD COLUMN IF NOT EXISTS can_add_members BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE chat_members ADD COLUMN IF NOT EXISTS can_pin_messages BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE chat_members ADD COLUMN IF NOT EXISTS muted_until TIMESTAMPTZ;
ALTER TABLE chat_members ADD COLUMN IF NOT EXISTS mute_reason TEXT;
ALTER TABLE chat_members ADD COLUMN IF NOT EXISTS banned_until TIMESTAMPTZ;
ALTER TABLE chat_members ADD COLUMN IF NOT EXISTS ban_reason TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS forwarded_from_user_id TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS forwarded_from_message_id TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS album_id TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS report_id TEXT;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS accent_color TEXT NOT NULL DEFAULT '#4da3ff';
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS show_favorite_tab BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS show_archive_tab BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS phone_visibility TEXT NOT NULL DEFAULT 'everyone';
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS last_seen_visibility TEXT NOT NULL DEFAULT 'everyone';
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS allow_username_lookup BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS telegram_bindings (
  phone TEXT PRIMARY KEY,
  telegram_chat_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_members_user_id ON chat_members(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_chat_id_created_at ON messages(chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id);
CREATE INDEX IF NOT EXISTS idx_users_display_name ON users(display_name);
CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_chats_username ON chats(username);
CREATE INDEX IF NOT EXISTS idx_chat_invites_chat_id ON chat_invites(chat_id);
CREATE INDEX IF NOT EXISTS idx_user_reports_status ON user_reports(status);
CREATE INDEX IF NOT EXISTS idx_messages_report_id ON messages(report_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_revoked_at ON user_sessions(revoked_at);
CREATE INDEX IF NOT EXISTS idx_user_reports_reported_user_id ON user_reports(reported_user_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_chat_id ON scheduled_messages(chat_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_scheduled_for ON scheduled_messages(scheduled_for);
CREATE INDEX IF NOT EXISTS idx_chat_invites_token ON chat_invites(token);
CREATE INDEX IF NOT EXISTS idx_user_folders_user_id ON user_folders(user_id);
CREATE INDEX IF NOT EXISTS idx_user_folder_chats_folder_id ON user_folder_chats(folder_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_unique ON users ((LOWER(username))) WHERE username IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_chats_username_unique ON chats ((LOWER(username))) WHERE username IS NOT NULL;
