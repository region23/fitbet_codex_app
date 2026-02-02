import type Database from "better-sqlite3";
import type { StorageAdapter } from "grammy";

export class SqliteSessionStorage<TSession> implements StorageAdapter<TSession> {
  private readonly sqlite: Database.Database;

  constructor(sqlite: Database.Database) {
    this.sqlite = sqlite;
  }

  read(key: string): Promise<TSession | undefined> {
    const row = this.sqlite
      .prepare("SELECT value FROM bot_sessions WHERE key = ?")
      .get(key) as { value: string } | undefined;
    if (!row) return Promise.resolve(undefined);
    return Promise.resolve(JSON.parse(row.value) as TSession);
  }

  write(key: string, value: TSession): Promise<void> {
    const now = Date.now();
    const json = JSON.stringify(value);
    this.sqlite
      .prepare(
        "INSERT INTO bot_sessions(key, value, updated_at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
      )
      .run(key, json, now);
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.sqlite.prepare("DELETE FROM bot_sessions WHERE key = ?").run(key);
    return Promise.resolve();
  }
}

