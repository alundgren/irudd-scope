import { Effect } from "effect";
import type { SqliteClient } from "@effect/sql-sqlite-node";
import type { ChatHarnessId, ChatItem } from "../plugins/canvas/chat/contract.ts";

type Database = {
  sql: SqliteClient.SqliteClient;
  run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
};

export const CHAT_SCHEMA_VERSION = 20;

/** What Scope keeps of one card's chat: what the panel shows and how to continue it. */
export type SavedChat = {
  harness: ChatHarnessId | null;
  session: string | null;
  /** A turn was running when this was saved; after a restart it shows as interrupted. */
  running: boolean;
  items: ChatItem[];
  /** The running turn's ID and changes, so Undo turn still works after a restart. */
  turn: { id: string; changes: string[] } | null;
};

/**
 * One row per card chat. It goes away with the card's row, which stays while the board's
 * history can still bring a deleted card back.
 */
export function createChatTable(sql: SqliteClient.SqliteClient) {
  return sql.withTransaction(
    Effect.gen(function* () {
      const [{ user_version }] = yield* sql<{ user_version: number }>`PRAGMA user_version`;
      if (user_version >= CHAT_SCHEMA_VERSION) return;
      yield* sql`CREATE TABLE IF NOT EXISTS canvas_chat (tab_id TEXT NOT NULL, card_id TEXT NOT NULL, harness TEXT CHECK(harness IN ('claude', 'codex')), harness_session TEXT, running INTEGER NOT NULL CHECK(running IN (0, 1)), items TEXT NOT NULL CHECK(json_valid(items) AND json_type(items) = 'array'), turn TEXT CHECK(turn IS NULL OR json_valid(turn)), updated_at INTEGER NOT NULL, PRIMARY KEY(tab_id, card_id), FOREIGN KEY(tab_id, card_id) REFERENCES canvas_cards(tab_id, card_id) ON DELETE CASCADE) STRICT`;
      // The working folders this Scope made, so cleanup never touches another Scope's folders.
      yield* sql`CREATE TABLE IF NOT EXISTS canvas_chat_folders (card_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL) STRICT`;
      yield* sql`PRAGMA user_version = ${sql.literal(String(CHAT_SCHEMA_VERSION))}`;
    }),
  );
}

export class CardChatStore {
  constructor(private readonly database: Database) {}

  initialize(): Promise<void> {
    return this.database.run(createChatTable(this.database.sql));
  }

  async read(tabId: string, cardId: string): Promise<SavedChat | null> {
    const { sql, run } = this.database;
    const [row] = await run(
      sql<{
        harness: ChatHarnessId | null;
        harness_session: string | null;
        running: number;
        items: string;
        turn: string | null;
      }>`SELECT harness, harness_session, running, items, turn FROM canvas_chat WHERE tab_id = ${tabId} AND card_id = ${cardId}`,
    );
    if (!row) return null;
    return {
      harness: row.harness,
      session: row.harness_session,
      running: row.running === 1,
      items: JSON.parse(row.items) as ChatItem[],
      turn: row.turn ? (JSON.parse(row.turn) as SavedChat["turn"]) : null,
    };
  }

  /** Saves a card's chat. A card without a row, such as one deleted for good, keeps nothing. */
  async save(tabId: string, cardId: string, chat: SavedChat): Promise<void> {
    const { sql, run } = this.database;
    await run(
      sql`INSERT INTO canvas_chat(tab_id, card_id, harness, harness_session, running, items, turn, updated_at) SELECT ${tabId}, ${cardId}, ${chat.harness}, ${chat.session}, ${chat.running ? 1 : 0}, ${JSON.stringify(chat.items)}, ${chat.turn ? JSON.stringify(chat.turn) : null}, ${Date.now()} WHERE EXISTS (SELECT 1 FROM canvas_cards WHERE tab_id = ${tabId} AND card_id = ${cardId}) ON CONFLICT(tab_id, card_id) DO UPDATE SET harness = excluded.harness, harness_session = excluded.harness_session, running = excluded.running, items = excluded.items, turn = excluded.turn, updated_at = excluded.updated_at`,
    );
  }

  async folderMade(cardId: string): Promise<void> {
    const { sql, run } = this.database;
    await run(
      sql`INSERT INTO canvas_chat_folders(card_id, created_at) VALUES (${cardId}, ${Date.now()}) ON CONFLICT(card_id) DO NOTHING`,
    );
  }

  /** Cards whose folder this Scope made and that are gone for good: no row can bring them back. */
  async goneFolders(): Promise<string[]> {
    const { sql, run } = this.database;
    const rows = await run(
      sql<{
        card_id: string;
      }>`SELECT card_id FROM canvas_chat_folders WHERE card_id NOT IN (SELECT card_id FROM canvas_cards)`,
    );
    return rows.map((row) => row.card_id);
  }

  async forgetFolder(cardId: string): Promise<void> {
    const { sql, run } = this.database;
    await run(sql`DELETE FROM canvas_chat_folders WHERE card_id = ${cardId}`);
  }
}
