/*
 * CLI entrypoint for the review eval (IMPROVEMENT-PLAN §2.4). Three
 * subcommands wire the miner, the injector and the harness+scorer together
 * into something runnable from a terminal or CI, without adding a CLI
 * framework dependency - `node:util`'s parseArgs is enough for three flat
 * subcommands.
 *
 * Run through `tsx`, e.g. `pnpm eval mine --repo .`.
 */

import { createInterface } from "node:readline/promises";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { mineHistoryCases } from "./mine.js";
import { injectCases } from "./inject.js";
import { runCases } from "./harness.js";
import { scoreCases, renderReportMarkdown } from "./score.js";
import type { EvalCase } from "./types.js";
import { logger } from "../utils/logger.js";

/** §2.5 hard cost cap per review; the worst-case estimate the run subcommand prints before spending. */
const HARD_CAP_USD_PER_REVIEW = 0.5;

async function writeJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(resolve(path), JSON.stringify(data, null, 2) + "\n", "utf-8");
}

async function readCasesFile(path: string): Promise<EvalCase[]> {
  let raw: string;
  try {
    raw = await readFile(resolve(path), "utf-8");
  } catch (err) {
    throw new Error(`Case file not found: ${path} (${String(err)})`);
  }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Case file ${path} does not contain a JSON array`);
  }
  return parsed as EvalCase[];
}

async function readExistingCasesOrEmpty(path: string): Promise<EvalCase[]> {
  try {
    return await readCasesFile(path);
  } catch {
    return [];
  }
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

async function runMine(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      repo: { type: "string" },
      max: { type: "string" },
      "since-days": { type: "string" },
      out: { type: "string" },
    },
  });

  if (!values.repo) {
    throw new Error("mine: --repo <path> is required");
  }
  const out = values.out ?? ".eval/cases.json";

  const cases = await mineHistoryCases(values.repo, {
    maxCases: values.max ? Number(values.max) : undefined,
    sinceDays: values["since-days"] ? Number(values["since-days"]) : undefined,
  });

  await writeJson(out, cases);
  logger.info({ count: cases.length, out }, "Mined tier 1 cases");
  process.stdout.write(`Mined ${cases.length} case(s) -> ${out}\n`);
}

async function runInject(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      repo: { type: "string" },
      max: { type: "string" },
      "work-dir": { type: "string" },
      out: { type: "string" },
    },
  });

  if (!values.repo) {
    throw new Error("inject: --repo <path> is required");
  }
  if (!values["work-dir"]) {
    throw new Error("inject: --work-dir <path> is required");
  }
  const out = values.out ?? ".eval/cases.json";

  const injected = await injectCases(values.repo, {
    workDir: values["work-dir"],
    maxCases: values.max ? Number(values.max) : undefined,
  });

  const existing = await readExistingCasesOrEmpty(out);
  const merged = [...existing, ...injected];
  await writeJson(out, merged);
  logger.info(
    { injected: injected.length, total: merged.length, out },
    "Injected tier 2 cases"
  );
  process.stdout.write(`Injected ${injected.length} case(s) -> ${out} (${merged.length} total)\n`);
}

async function runRun(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      cases: { type: "string" },
      "run-twice": { type: "boolean" },
      out: { type: "string" },
      yes: { type: "boolean" },
    },
  });

  if (!values.cases) {
    throw new Error("run: --cases <file> is required");
  }
  const cases = await readCasesFile(values.cases);
  const outJson = values.out ?? ".eval/report.json";
  const outMd = outJson.endsWith(".json")
    ? outJson.slice(0, -".json".length) + ".md"
    : outJson + ".md";

  const runTwice = values["run-twice"] === true;
  const multiplier = runTwice ? 2 : 1;
  const worstCaseUsd = cases.length * HARD_CAP_USD_PER_REVIEW * multiplier;

  process.stdout.write(
    `${cases.length} case(s) to run${runTwice ? " (run-twice enabled)" : ""}. ` +
      `Worst case at the $${HARD_CAP_USD_PER_REVIEW.toFixed(2)} hard cap per review: $${worstCaseUsd.toFixed(2)}.\n`
  );

  if (!values.yes) {
    const proceed = await confirm("This spends real money. Proceed?");
    if (!proceed) {
      process.stdout.write("Aborted.\n");
      process.exitCode = 1;
      return;
    }
  }

  const outcomes = await runCases(cases, {
    runTwice,
    onProgress: (done, total) => {
      process.stdout.write(`  [${done}/${total}] cases done\n`);
    },
  });

  const report = scoreCases(cases, outcomes);
  await writeJson(outJson, report);
  const markdown = renderReportMarkdown(report, cases, outcomes);
  await mkdir(dirname(resolve(outMd)), { recursive: true });
  await writeFile(resolve(outMd), markdown, "utf-8");

  process.stdout.write(
    `\nPrecision: ${pct(report.overall.precision)}  Recall: ${pct(report.overall.recall)}  ` +
      `Errored: ${report.erroredCases}/${report.overall.cases}\n` +
      `Report -> ${outJson}, ${outMd}\n`
  );
}

function pct(value: number | null): string {
  return value === null ? "N/A" : `${(value * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const [subcommand, ...rest] = process.argv.slice(2);

  switch (subcommand) {
    case "mine":
      await runMine(rest);
      return;
    case "inject":
      await runInject(rest);
      return;
    case "run":
      await runRun(rest);
      return;
    default:
      throw new Error(
        `Unknown subcommand "${subcommand ?? ""}". Expected one of: mine, inject, run.`
      );
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
