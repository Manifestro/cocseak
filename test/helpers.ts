import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const tempDir = (): { path: string; cleanup: () => void } => {
  const path = mkdtempSync(join(tmpdir(), "cocseak-test-"));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
};
