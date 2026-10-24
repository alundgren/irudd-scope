// The folder writer process: Folder tab writes that need their own working directory run
// here, never in this app's main process. See packages/folder/src/writer.ts.
import { runFolderWriterProcess } from "@irudd-scope/folder";

runFolderWriterProcess();
