import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The Postman CLI, run against a collection FILE.
 *
 * **Never against a cloud collection id**: a run named by id is uploaded to the workspace that owns
 * it. A file run is not published (the CLI says so), and `--no-report-events` turns off the usage
 * events the CLI otherwise sends.
 *
 * **A missing binary fails the suite, it does not skip it.** A skipped oracle reports exactly what a
 * passing one does.
 */

export interface RunExecution {
	readonly id: string;
	readonly name: string;
	readonly method: string;
	readonly code: number | undefined;
	readonly tests: readonly { readonly name: string; readonly status: string }[];
}

export interface RunResult {
	readonly exitCode: number;
	readonly output: string;
	readonly executions: readonly RunExecution[];
}

interface NativeReport {
	readonly run: {
		readonly executions: readonly {
			readonly requestExecuted: {
				readonly id: string;
				readonly name: string;
				readonly method: string;
			};
			readonly response?: { readonly code?: number };
			readonly tests?: readonly { readonly name: string; readonly status: string }[];
		}[];
	};
}

export async function runCollection(
	collectionFile: string,
	variables: Readonly<Record<string, string>>,
	reportFile: string,
): Promise<RunResult> {
	rmSync(reportFile, { force: true });
	mkdirSync(dirname(reportFile), { recursive: true });
	const args = [
		"collection",
		"run",
		collectionFile,
		...Object.entries(variables).flatMap(([key, value]) => ["--env-var", `${key}=${value}`]),
		"--no-report-events",
		"--disable-unicode",
		"-r",
		"cli,json",
		"--reporter-json-export",
		reportFile,
	];
	const { exitCode, output } = await new Promise<{ exitCode: number; output: string }>(
		(resolve, reject) => {
			execFile(
				"postman",
				args,
				{ cwd: dirname(reportFile), maxBuffer: 64 * 1024 * 1024 },
				(error, stdout, stderr) => {
					if (error !== null && (error as NodeJS.ErrnoException).code === "ENOENT") {
						reject(
							new Error(
								"The `postman` CLI is not on PATH. Install it: https://learning.postman.com/docs/postman-cli/postman-cli-installation/",
							),
						);
						return;
					}
					const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
					resolve({ exitCode: code, output: `${stdout}${stderr}` });
				},
			);
		},
	);
	let report: NativeReport;
	try {
		report = JSON.parse(readFileSync(reportFile, "utf8")) as NativeReport;
	} catch {
		throw new Error(`The Postman CLI wrote no report (exit ${exitCode}):\n${output}`);
	}
	return {
		exitCode,
		output,
		executions: report.run.executions.map((execution) => ({
			id: execution.requestExecuted.id,
			name: execution.requestExecuted.name,
			method: execution.requestExecuted.method,
			code: execution.response?.code,
			tests: execution.tests ?? [],
		})),
	};
}

export const REPORTS = (dir: string, name: string) => join(dir, ".out", "reports", `${name}.json`);
