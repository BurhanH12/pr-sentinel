import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { PathRulePack, ReviewSkillRef } from "../types.js";

export type ReviewStack = "nestjs" | "nextjs" | "react";

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const TARGET_CONTEXT_FILES = ["AGENTS.md", "CONTEXT.md"];
const CONTEXT_CHAR_LIMIT = 4_000;
const SKILL_CHAR_LIMIT = 3_000;

const STACK_SKILLS: Record<ReviewStack, ReviewSkillRef[]> = {
  nestjs: ["nestjs-best-practices"],
  nextjs: ["vercel-react-best-practices"],
  react: ["vercel-react-best-practices"],
};

/**
 * Detects the target repo's application stack from package metadata and paths.
 */
export function detectReviewStacks(
  manifest: unknown,
  changedPaths: string[]
): ReviewStack[] {
  const packageManifest = parsePackageManifest(manifest);
  const dependencyNames = new Set([
    ...Object.keys(packageManifest.dependencies ?? {}),
    ...Object.keys(packageManifest.devDependencies ?? {}),
    ...Object.keys(packageManifest.peerDependencies ?? {}),
  ]);

  const stacks = new Set<ReviewStack>();
  if (
    [...dependencyNames].some((name) => name.startsWith("@nestjs/")) ||
    changedPaths.some((path) => /(^|\/)(apps\/api|api|server)(\/|$)/i.test(path))
  ) {
    stacks.add("nestjs");
  }

  if (
    dependencyNames.has("next") ||
    changedPaths.some((path) => /(^|\/)(app|pages)\/.*\.(tsx|ts)$/i.test(path))
  ) {
    stacks.add("nextjs");
  }

  if (
    dependencyNames.has("react") ||
    changedPaths.some((path) => /\.(tsx|jsx)$/i.test(path))
  ) {
    stacks.add("react");
  }

  return [...stacks];
}

/**
 * Reads the target repo's package.json and detects its stacks once, so the
 * prompt builder and rule routing share one result.
 */
export async function detectStacks(
  cwd: string,
  changedPaths: string[]
): Promise<ReviewStack[]> {
  const manifest = await readJsonFile(join(cwd, "package.json"));
  return detectReviewStacks(manifest, changedPaths);
}

/**
 * Builds the prompt section containing repo-local guidance and relevant skills.
 */
export async function buildRuntimeKnowledgeSection(
  cwd: string,
  changedPaths: string[],
  matchingPathRules: PathRulePack[],
  stacks: ReviewStack[]
): Promise<string> {
  const skillRefs = resolveSkillRefs(stacks, matchingPathRules, changedPaths);
  const targetContext = await readTargetContext(cwd);
  const skillSections = await readSkillSections(skillRefs);

  if (
    stacks.length === 0 &&
    targetContext.length === 0 &&
    skillSections.length === 0 &&
    matchingPathRules.length === 0
  ) {
    return "";
  }

  const lines: string[] = ["", "## Runtime project knowledge", ""];

  if (stacks.length > 0) {
    lines.push(`Detected stacks: ${stacks.join(", ")}`, "");
  }

  if (targetContext.length > 0) {
    lines.push("### Target repository guidance", "");
    lines.push(...targetContext);
  }

  if (matchingPathRules.length > 0) {
    lines.push("### Matched path rules", "");
    for (const pack of matchingPathRules) {
      lines.push(`Patterns: ${pack.patterns.join(", ")}`);
      if (pack.focusAreas?.length) {
        lines.push(`Focus: ${pack.focusAreas.join(", ")}`);
      }
      if (pack.rules) {
        lines.push(pack.rules);
      }
      if (pack.skillRefs?.length) {
        lines.push(`Skills: ${pack.skillRefs.join(", ")}`);
      }
      lines.push("");
    }
  }

  if (skillSections.length > 0) {
    lines.push("### Relevant review skills", "");
    lines.push(...skillSections);
  }

  return lines.join("\n");
}

function resolveSkillRefs(
  stacks: ReviewStack[],
  matchingPathRules: PathRulePack[],
  changedPaths: string[]
): ReviewSkillRef[] {
  const refs = new Set<ReviewSkillRef>(["code-review-and-quality"]);

  for (const stack of stacks) {
    for (const ref of STACK_SKILLS[stack]) refs.add(ref);
  }

  if (changedPaths.some(isSecuritySensitivePath)) {
    refs.add("security-best-practices");
  }

  for (const pack of matchingPathRules) {
    for (const ref of pack.skillRefs ?? []) refs.add(ref);
  }

  return [...refs];
}

function isSecuritySensitivePath(path: string): boolean {
  return /(^|\/)(auth|security|session|sessions|permission|permissions|guard|guards|jwt|oauth|password|token|tokens|crypto)(\/|\.|-|_)/i.test(
    path
  );
}

async function readTargetContext(cwd: string): Promise<string[]> {
  const sections: string[] = [];
  for (const filename of TARGET_CONTEXT_FILES) {
    const content = await readTextFile(join(cwd, filename));
    if (!content) continue;
    sections.push(`#### ${filename}`, truncate(content, CONTEXT_CHAR_LIMIT), "");
  }
  return sections;
}

async function readSkillSections(
  skillRefs: ReviewSkillRef[]
): Promise<string[]> {
  const sections: string[] = [];
  for (const ref of skillRefs) {
    const content = await readBundledSkill(ref);
    if (!content) continue;
    sections.push(`#### ${ref}`, truncate(content, SKILL_CHAR_LIMIT), "");
  }
  return sections;
}

async function readBundledSkill(ref: ReviewSkillRef): Promise<string | null> {
  for (const root of skillRootCandidates()) {
    const content = await readTextFile(join(root, ref, "SKILL.md"));
    if (content) return content;
  }
  return null;
}

function skillRootCandidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [join(process.cwd(), "skills"), join(here, "..", "..", "skills")];
}

async function readJsonFile(path: string): Promise<unknown> {
  const raw = await readTextFile(path);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

async function readTextFile(path: string): Promise<string | null> {
  try {
    const content = await readFile(path, "utf-8");
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

function parsePackageManifest(manifest: unknown): PackageManifest {
  if (!isRecord(manifest)) return {};
  return {
    dependencies: readDependencyRecord(manifest.dependencies),
    devDependencies: readDependencyRecord(manifest.devDependencies),
    peerDependencies: readDependencyRecord(manifest.peerDependencies),
  };
}

function readDependencyRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string"
  );
  return Object.fromEntries(entries);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(content: string, limit: number): string {
  if (content.length <= limit) return content;
  return `${content.slice(0, limit).trimEnd()}\n\n...[truncated]`;
}
