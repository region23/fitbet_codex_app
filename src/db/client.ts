import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { seedCommitmentTemplates } from "./seeds.js";

export type AppDb = {
  sqlite: Database.Database;
  db: BetterSQLite3Database;
  close: () => void;
};

export function createAppDb(databaseUrl: string): AppDb {
  const filename = sqliteFilenameFromUrl(databaseUrl);
  if (filename !== ":memory:") {
    const dir = path.dirname(filename);
    fs.mkdirSync(dir, { recursive: true });
  }

  const sqlite = new Database(filename);
  sqlite.pragma("foreign_keys = ON");
  applySchema(sqlite);

  const db = drizzle(sqlite);
  seedCommitmentTemplates(db);

  return { sqlite, db, close: () => sqlite.close() };
}

function sqliteFilenameFromUrl(databaseUrl: string): string {
  if (!databaseUrl) return "data/fitbet.db";

  if (databaseUrl === ":memory:" || databaseUrl === "file::memory:") return ":memory:";

  if (databaseUrl.startsWith("file:")) {
    const filepath = databaseUrl.slice("file:".length);
    return filepath || "data/fitbet.db";
  }

  return databaseUrl;
}

function applySchema(sqlite: Database.Database) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS bot_sessions (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS challenges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      chat_title TEXT NOT NULL,
      creator_id INTEGER NOT NULL,
      duration_months INTEGER NOT NULL,
      stake_amount REAL NOT NULL,
      discipline_threshold REAL NOT NULL,
      max_skips INTEGER NOT NULL,
      bank_holder_id INTEGER,
      bank_holder_username TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      ends_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS challenges_chat_id_idx ON challenges(chat_id);

    CREATE TABLE IF NOT EXISTS participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      challenge_id INTEGER NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      username TEXT,
      first_name TEXT,
      track TEXT,
      start_weight REAL,
      start_waist REAL,
      height REAL,
      start_photo_front_id TEXT,
      start_photo_left_id TEXT,
      start_photo_right_id TEXT,
      start_photo_back_id TEXT,
      total_checkins INTEGER NOT NULL DEFAULT 0,
      completed_checkins INTEGER NOT NULL DEFAULT 0,
      skipped_checkins INTEGER NOT NULL DEFAULT 0,
      pending_checkin_window_id INTEGER,
      pending_checkin_requested_at INTEGER,
      status TEXT NOT NULL,
      joined_at INTEGER NOT NULL,
      onboarding_completed_at INTEGER,
      UNIQUE(challenge_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS participants_challenge_id_idx ON participants(challenge_id);
    CREATE INDEX IF NOT EXISTS participants_user_id_idx ON participants(user_id);
    CREATE INDEX IF NOT EXISTS participants_status_idx ON participants(status);

    CREATE TABLE IF NOT EXISTS goals (
      participant_id INTEGER PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
      target_weight REAL NOT NULL,
      target_waist REAL NOT NULL,
      is_validated INTEGER NOT NULL DEFAULT 0,
      validation_result TEXT,
      validation_feedback TEXT,
      validated_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS goals_is_validated_idx ON goals(is_validated);

    CREATE TABLE IF NOT EXISTS checkin_windows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      challenge_id INTEGER NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
      window_number INTEGER NOT NULL,
      opens_at INTEGER NOT NULL,
      closes_at INTEGER NOT NULL,
      reminder_sent_at INTEGER,
      status TEXT NOT NULL,
      UNIQUE(challenge_id, window_number)
    );
    CREATE INDEX IF NOT EXISTS checkin_windows_status_idx ON checkin_windows(status);
    CREATE INDEX IF NOT EXISTS checkin_windows_opens_at_idx ON checkin_windows(opens_at);
    CREATE INDEX IF NOT EXISTS checkin_windows_closes_at_idx ON checkin_windows(closes_at);

    CREATE TABLE IF NOT EXISTS checkins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      window_id INTEGER NOT NULL REFERENCES checkin_windows(id) ON DELETE CASCADE,
      weight REAL NOT NULL,
      waist REAL NOT NULL,
      photo_front_id TEXT,
      photo_left_id TEXT,
      photo_right_id TEXT,
      photo_back_id TEXT,
      submitted_at INTEGER NOT NULL,
      UNIQUE(participant_id, window_id)
    );
    CREATE INDEX IF NOT EXISTS checkins_participant_id_idx ON checkins(participant_id);
    CREATE INDEX IF NOT EXISTS checkins_window_id_idx ON checkins(window_id);

    CREATE TABLE IF NOT EXISTS commitment_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      UNIQUE(name)
    );
    CREATE INDEX IF NOT EXISTS commitment_templates_is_active_idx ON commitment_templates(is_active);

    CREATE TABLE IF NOT EXISTS participant_commitments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      template_id INTEGER NOT NULL REFERENCES commitment_templates(id) ON DELETE RESTRICT,
      created_at INTEGER NOT NULL,
      UNIQUE(participant_id, template_id)
    );
    CREATE INDEX IF NOT EXISTS participant_commitments_participant_id_idx ON participant_commitments(participant_id);

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      marked_paid_at INTEGER,
      confirmed_at INTEGER,
      confirmed_by INTEGER,
      UNIQUE(participant_id)
    );
    CREATE INDEX IF NOT EXISTS payments_status_idx ON payments(status);

    CREATE TABLE IF NOT EXISTS bank_holder_elections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      challenge_id INTEGER NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
      initiated_by INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      UNIQUE(challenge_id)
    );
    CREATE INDEX IF NOT EXISTS bank_holder_elections_status_idx ON bank_holder_elections(status);

    CREATE TABLE IF NOT EXISTS bank_holder_votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      election_id INTEGER NOT NULL REFERENCES bank_holder_elections(id) ON DELETE CASCADE,
      voter_id INTEGER NOT NULL,
      voted_for_id INTEGER NOT NULL,
      voted_at INTEGER NOT NULL,
      UNIQUE(election_id, voter_id)
    );
    CREATE INDEX IF NOT EXISTS bank_holder_votes_election_id_idx ON bank_holder_votes(election_id);

    CREATE TABLE IF NOT EXISTS checkin_recommendations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      checkin_id INTEGER NOT NULL REFERENCES checkins(id) ON DELETE CASCADE,
      participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      progress_assessment TEXT,
      body_composition_notes TEXT,
      nutrition_advice TEXT,
      training_advice TEXT,
      motivational_message TEXT,
      warning_flags TEXT,
      llm_model TEXT,
      tokens_used INTEGER,
      processing_time_ms INTEGER,
      created_at INTEGER NOT NULL,
      UNIQUE(checkin_id)
    );
    CREATE INDEX IF NOT EXISTS checkin_recommendations_participant_id_idx ON checkin_recommendations(participant_id);
  `);
}
