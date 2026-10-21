/**
 * The shipped core (src/) stays host-neutral: no clocks, randomness, timers,
 * network, filesystem or process; no node:/bun: modules; no imports that
 * escape src/ (standalone/, eval/). Static guard, not a sandbox.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";

const banned = new Set([
	"Bun",
	"process",
	"Date",
	"performance",
	"crypto",
	"fetch",
	"setTimeout",
	"setInterval",
	"setImmediate",
	"WebSocket",
	"XMLHttpRequest",
	"globalThis",
	"Math",
]);
const allowedMath = new Set(["round", "max", "min", "floor", "ceil", "abs"]);

const isTestFile = (name: string) =>
	name.endsWith(".test.ts") || name.split("/").includes("test");

/**
 * Checks one source file of src/. `srcRoot` is the absolute src directory and
 * `file` the absolute path of the file; returns one message per violation.
 */
export function checkSource(
	srcRoot: string,
	file: string,
	text: string,
): string[] {
	const name = relative(srcRoot, file);
	if (isTestFile(name)) return [];
	const errors: string[] = [];
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
	const lineOf = (node: ts.Node) =>
		source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
	const checkSpecifier = (spec: string, node: ts.Node) => {
		const where = `${name}:${lineOf(node)}`;
		if (spec.startsWith("node:") || spec.startsWith("bun:"))
			errors.push(`${where}: host module ${spec}`);
		else if (spec.startsWith(".")) {
			const rel = relative(srcRoot, resolve(dirname(file), spec));
			if (rel === ".." || rel.startsWith("../"))
				errors.push(`${where}: imports outside src (${spec})`);
		}
	};
	const visit = (node: ts.Node) => {
		if (
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier &&
			ts.isStringLiteral(node.moduleSpecifier)
		)
			checkSpecifier(node.moduleSpecifier.text, node);
		if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword
		) {
			const arg = node.arguments[0];
			if (arg && ts.isStringLiteralLike(arg)) checkSpecifier(arg.text, node);
			else errors.push(`${name}:${lineOf(node)}: dynamic import`);
		}
		if (ts.isIdentifier(node) && banned.has(node.text)) {
			const parent = node.parent;
			const isMember =
				ts.isPropertyAccessExpression(parent) && parent.name === node;
			const isKey =
				(ts.isPropertyAssignment(parent) ||
					ts.isPropertySignature(parent) ||
					ts.isMethodSignature(parent) ||
					ts.isMethodDeclaration(parent) ||
					ts.isPropertyDeclaration(parent)) &&
				parent.name === node;
			const mathOk =
				node.text === "Math" &&
				ts.isPropertyAccessExpression(parent) &&
				parent.expression === node &&
				allowedMath.has(parent.name.text);
			if (!isMember && !isKey && !mathOk && !ts.isImportSpecifier(parent))
				errors.push(`${name}:${lineOf(node)}: ambient ${node.text}`);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return errors;
}

const walk = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory()
			? walk(resolve(dir, e.name))
			: e.name.endsWith(".ts")
				? [resolve(dir, e.name)]
				: [],
	);

if (import.meta.main) {
	const srcRoot = resolve(import.meta.dir, "../src");
	const errors = walk(srcRoot).flatMap((file) =>
		checkSource(srcRoot, file, readFileSync(file, "utf8")),
	);
	if (errors.length) {
		console.error(errors.join("\n"));
		process.exit(1);
	}
	console.log("OK: core is host-neutral");
}
