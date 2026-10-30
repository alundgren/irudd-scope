// The agent sessions reader process: reads T3 Code's database and harness logs outside this
// app's main process, because SQLite reads block. See packages/sessions/src/index.ts.
import { runSessionsReaderProcess } from "@irudd-scope/sessions";

runSessionsReaderProcess();
