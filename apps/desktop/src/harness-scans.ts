import type { Effect } from "effect";
import type { SqliteClient } from "@effect/sql-sqlite-node";
import { decode } from "@irudd-scope/protocol";
import {
  HarnessScan,
  MAX_HARNESS_SCAN_BYTES,
  type HarnessMachine,
} from "@irudd-scope/protocol/harnesses";

type Storage = {
  sql: SqliteClient.SqliteClient;
  run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  enqueue: <A>(action: () => Promise<A>) => Promise<A>;
};

/** The latest harness scan per machine in desktop.db. */
export class HarnessScanStore {
  constructor(private readonly storage: Storage) {}

  // Older Scope versions ignore this table, so it needs no schema version. The length limit
  // is MAX_HARNESS_SCAN_BYTES; SQLite does not accept parameters in a table definition.
  // Tables from builds that shared tabs with other desktops also accepted `guest:` machines.
  // The desktop scans again at every start, so such a table is dropped and recreated.
  async initialize() {
    const { sql, run } = this.storage;
    const [table] = await run(
      sql<{
        sql: string;
      }>`SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'harness_scans'`,
    );
    if (table?.sql.includes("guest:")) await run(sql`DROP TABLE harness_scans`);
    await run(sql`CREATE TABLE IF NOT EXISTS harness_scans (
      machine TEXT PRIMARY KEY
        CHECK (machine = 'local' OR machine LIKE 'remote:%'),
      document TEXT NOT NULL
        CHECK (json_valid(document) AND length(document) <= 262144)
    ) STRICT`);
  }

  /** A saved scan that no longer validates is treated as missing and replaced by the next scan. */
  read(machine: HarnessMachine): Promise<HarnessScan | null> {
    return this.storage.enqueue(async () => {
      const [row] = await this.storage.run(
        this.storage.sql<{
          document: string;
        }>`SELECT document FROM harness_scans WHERE machine = ${machine}`,
      );
      if (!row) return null;
      try {
        const scan = decode(HarnessScan, JSON.parse(row.document));
        return scan.machine === machine ? scan : null;
      } catch {
        return null;
      }
    });
  }

  /** Returns false when the scan exceeds the saved size limit and was not saved. */
  save(scan: HarnessScan): Promise<boolean> {
    const document = JSON.stringify(decode(HarnessScan, scan));
    if (Buffer.byteLength(document) > MAX_HARNESS_SCAN_BYTES) return Promise.resolve(false);
    return this.storage.enqueue(async () => {
      await this.storage.run(
        this.storage
          .sql`INSERT INTO harness_scans(machine, document) VALUES (${scan.machine}, ${document})
          ON CONFLICT(machine) DO UPDATE SET document = excluded.document`,
      );
      return true;
    });
  }
}
