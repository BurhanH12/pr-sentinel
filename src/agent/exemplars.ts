import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { PullRequestFile } from "../types.js";
import { logger } from "../utils/logger.js";

const MAX_NEW_FILES = 3;
const MAX_EXEMPLARS_PER_FILE = 3;
const EXEMPLAR_CHAR_LIMIT = 2_500;
const SECTION_CHAR_LIMIT = 12_000;
const MAX_EXEMPLAR_BYTES = 20 * 1024;
const IGNORED_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  "coverage",
  ".next",
]);
const ROLE_SUFFIX = /^.+(\.[a-z0-9-]+\.[a-z0-9]+)$/i;
const TRUNCATION_MARKER = "\n...[truncated]";

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - TRUNCATION_MARKER.length).trimEnd()}${TRUNCATION_MARKER}`;
}

function segments(dir: string): string[] {
  return dir === "." || dir === "" ? [] : dir.split("/");
}

/*
 * Path-segment distance between two directories: steps up from one to the
 * common ancestor plus steps down to the other. Same directory is 0.
 */
function dirDistance(a: string, b: string): number {
  const sa = segments(a);
  const sb = segments(b);
  let common = 0;
  while (common < sa.length && common < sb.length && sa[common] === sb[common]) {
    common++;
  }
  return sa.length + sb.length - 2 * common;
}

async function listCandidates(
  root: string,
  dir: string,
  suffixes: Set<string>,
  out: Map<string, string[]>
): Promise<void> {
  const entries = await readdir(join(root, dir), { withFileTypes: true });
  for (const entry of entries) {
    const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        await listCandidates(root, rel, suffixes, out);
      }
      continue;
    }
    // Symlinks are skipped: the checkout is untrusted and a link could point outside it.
    if (!entry.isFile()) continue;
    const suffix = ROLE_SUFFIX.exec(entry.name)?.[1]?.toLowerCase();
    if (suffix && suffixes.has(suffix)) {
      out.get(suffix)?.push(rel);
    }
  }
}

/**
 * Builds the "Sibling exemplars" prompt section: for newly added files with a
 * `name.<role>.<ext>` basename, shows up to 3 existing files of the same kind
 * so convention drift is judged against real siblings. Fails soft to "".
 */
export async function buildExemplarSection(
  cwd: string,
  files: PullRequestFile[]
): Promise<string> {
  try {
    const prPaths = new Set(files.map((f) => f.filename));
    const newFiles = files
      .filter((f) => f.status === "added")
      .map((f) => ({
        path: f.filename,
        suffix: ROLE_SUFFIX.exec(basename(f.filename))?.[1]?.toLowerCase(),
      }))
      .filter((f): f is { path: string; suffix: string } => !!f.suffix)
      .sort((a, b) => a.path.localeCompare(b.path))
      .slice(0, MAX_NEW_FILES);
    if (newFiles.length === 0) return "";

    const candidates = new Map<string, string[]>();
    for (const { suffix } of newFiles) candidates.set(suffix, []);
    await listCandidates(cwd, "", new Set(candidates.keys()), candidates);

    const blocks: string[] = [];
    for (const { path, suffix } of newFiles) {
      const dir = dirname(path);
      const ranked = (candidates.get(suffix) ?? [])
        .filter((p) => !prPaths.has(p))
        .map((p) => ({ p, d: dirDistance(dir, dirname(p)) }))
        .sort((a, b) => a.d - b.d || a.p.localeCompare(b.p));

      const picked: string[] = [];
      for (const { p } of ranked) {
        if (picked.length === MAX_EXEMPLARS_PER_FILE) break;
        const info = await stat(join(cwd, p));
        if (info.size > MAX_EXEMPLAR_BYTES) continue;
        const content = await readFile(join(cwd, p), "utf8");
        picked.push(
          `#### Exemplar: \`${p}\`\n\n\`\`\`\n${truncate(content, EXEMPLAR_CHAR_LIMIT)}\n\`\`\``
        );
      }
      if (picked.length === 0) continue;
      blocks.push(
        `### Existing files of the same kind as newly added \`${path}\`\n\n${picked.join("\n\n")}`
      );
    }
    if (blocks.length === 0) return "";

    const header =
      "## Sibling exemplars\n\n" +
      "These are existing files of the same kind as the newly added files named below. " +
      "Judge whether each new file follows the same structure, naming, error handling, and dependency patterns. " +
      "Flag only concrete, verifiable deviations and cite the exemplar path.\n\n";
    return `${truncate(header + blocks.join("\n\n"), SECTION_CHAR_LIMIT)}\n`;
  } catch (err) {
    logger.warn({ err }, "Exemplar section failed; continuing without it");
    return "";
  }
}
