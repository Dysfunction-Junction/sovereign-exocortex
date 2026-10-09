/**
 * Lightweight Zero-Dependency Environment Loader
 *
 * Reads .env file in the current working directory if present,
 * without overriding already-defined process.env variables.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export function loadEnv(envPath?: string): void {
  const targetPath = envPath ?? path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(targetPath)) {
    return;
  }

  // Use Node.js 20.6+ native loadEnvFile if available
  if (typeof (process as any).loadEnvFile === "function") {
    try {
      (process as any).loadEnvFile(targetPath);
      return;
    } catch {
      // Fallback to manual parsing if native fails
    }
  }

  try {
    const content = fs.readFileSync(targetPath, "utf-8");
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;

      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();

      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      if (key && !(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch {
    // Non-fatal if .env cannot be read
  }
}
