import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let categories: Record<string, string> = {};
try {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const jsonPath = join(currentDir, "data", "playCategories.json");
  categories = JSON.parse(readFileSync(jsonPath, "utf8"));
} catch {
  try {
    const fallbackPath = join(process.cwd(), "apps/daemon/src/data/playCategories.json");
    categories = JSON.parse(readFileSync(fallbackPath, "utf8"));
  } catch {}
}

export const PLAY_CATEGORIES: Record<string, string> = categories;
