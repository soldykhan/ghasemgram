'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function open(file) {
  try {
    const Database = require('better-sqlite3');
    return new Database(file);
  } catch (e) {
    // اگر better-sqlite3 در دسترس نبود، از ماژول داخلی Node (22.13+) استفاده کن
    const { DatabaseSync } = require('node:sqlite');
    return new DatabaseSync(file);
  }
}

const db = open(path.join(DATA_DIR, 'ghasemgram.db'));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    avatar_file_id INTEGER,
    last_seen_at INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stored_name TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    uploaded_by INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK (type IN ('private', 'group', 'channel')),
    title TEXT,
    about TEXT,
    avatar_file_id INTEGER,
    created_by INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chat_members (
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member',
    pinned INTEGER NOT NULL DEFAULT 0,
    last_read_id INTEGER NOT NULL DEFAULT 0,
    joined_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (chat_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    sender_id INTEGER NOT NULL REFERENCES users(id),
    text TEXT,
    file_id INTEGER REFERENCES files(id),
    reply_to_id INTEGER,
    forward_from_id INTEGER,
    forward_from_name TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id);
  CREATE INDEX IF NOT EXISTS idx_members_user ON chat_members(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

  CREATE TABLE IF NOT EXISTS message_reactions (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_reactions_msg ON message_reactions(message_id);

  CREATE TABLE IF NOT EXISTS blocked_users (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, blocked_id)
  );
  CREATE INDEX IF NOT EXISTS idx_blocked_user ON blocked_users(user_id);

  CREATE TABLE IF NOT EXISTS polls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    question TEXT NOT NULL,
    is_anonymous INTEGER NOT NULL DEFAULT 1,
    allows_multiple INTEGER NOT NULL DEFAULT 0,
    is_quiz INTEGER NOT NULL DEFAULT 0,
    correct_option_id INTEGER,
    closed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS poll_options (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS poll_votes (
    poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
    option_id INTEGER NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (poll_id, option_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_poll_votes ON poll_votes(poll_id, user_id);

  CREATE TABLE IF NOT EXISTS chat_topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    icon TEXT,
    created_by INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_topics_chat ON chat_topics(chat_id);

  CREATE TABLE IF NOT EXISTS scheduled_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text TEXT,
    file_id INTEGER REFERENCES files(id),
    reply_to_id INTEGER,
    is_silent INTEGER NOT NULL DEFAULT 0,
    scheduled_for INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_scheduled_time ON scheduled_messages(scheduled_for);
`);

// مهاجرت دیتابیس‌های ساخته‌شده با نسخه‌های قبلی
function addColumnIfMissing(table, col, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}
addColumnIfMissing('chats', 'about', 'TEXT');
addColumnIfMissing('chats', 'invite_code', 'TEXT');
addColumnIfMissing('chats', 'is_saved', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('chats', 'pinned_message_id', 'INTEGER');
addColumnIfMissing('chats', 'topics_enabled', 'INTEGER NOT NULL DEFAULT 0');

addColumnIfMissing('messages', 'reply_to_id', 'INTEGER');
addColumnIfMissing('messages', 'forward_from_id', 'INTEGER');
addColumnIfMissing('messages', 'forward_from_name', 'TEXT');
addColumnIfMissing('messages', 'is_service', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('messages', 'edited_at', 'INTEGER');
addColumnIfMissing('messages', 'link_preview', 'TEXT');
addColumnIfMissing('messages', 'is_silent', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('messages', 'is_voice', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('messages', 'topic_id', 'INTEGER');

addColumnIfMissing('chat_members', 'pinned', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('chat_members', 'last_read_id', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('chat_members', 'joined_at', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('chat_members', 'muted_until', 'INTEGER NOT NULL DEFAULT 0');

addColumnIfMissing('users', 'bio', 'TEXT');
addColumnIfMissing('users', 'privacy_last_seen', "TEXT NOT NULL DEFAULT 'everyone'");
addColumnIfMissing('users', 'status', "TEXT NOT NULL DEFAULT 'approved'");

db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS admin_sessions (
    token TEXT PRIMARY KEY,
    admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );
`);

function ensureSafirBot() {
  let u = db.prepare("SELECT * FROM users WHERE username = 'safir'").get();
  if (!u) {
    const now = Date.now();
    const info = db.prepare(`
      INSERT INTO users (username, password_hash, display_name, status, bio, created_at, last_seen_at)
      VALUES ('safir', 'BOT_NO_LOGIN', 'سفیر', 'approved', 'ربات رسمی پیام‌رسان قاسم‌گرام برای اعلانات امنیتی', ?, ?)
    `).run(now, now);
    u = db.prepare("SELECT * FROM users WHERE id = ?").get(Number(info.lastInsertRowid));
  }
  return u;
}
ensureSafirBot();

try {
  db.exec("UPDATE messages SET is_voice = 1 WHERE file_id IN (SELECT id FROM files WHERE mime_type LIKE 'audio/%')");
} catch {}

module.exports = { db, UPLOAD_DIR, ensureSafirBot };
