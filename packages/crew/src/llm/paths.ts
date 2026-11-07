import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** `<appData>` = $PAP_HOME, else ~/.pixelartpitch. Created on first use. */
export function appDataDir(): string {
  const dir = process.env.PAP_HOME || join(homedir(), ".pixelartpitch");
  mkdirSync(dir, { recursive: true });
  return dir;
}
