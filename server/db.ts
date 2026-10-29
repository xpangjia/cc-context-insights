import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { join } from "path";
import { DATA_DIR } from "./paths";

mkdirSync(DATA_DIR, { recursive: true });
export const DB_FILE = process.env.CC_INSIGHTS_DB ?? join(DATA_DIR, "index.db");
export const db = new Database(DB_FILE, { create: true });
db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
