import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createSelfPort } from "../self-port/port.ts";

describe("self-port", () => {
	test("queues first unanswered request, then serves the answer", async () => {
		const dir = mkdtempSync(join(tmpdir(), "selfport-"));
		const port = createSelfPort(dir);
		port.setSalt("rep1");
		const req = {
			purpose: "update" as const,
			system: "s",
			prompt: "p",
			schema: z.object({ a: z.number() }),
			maxOutputTokens: 10,
		};
		await expect(
			port.complete(req, new AbortController().signal),
		).rejects.toThrow();
		expect(port.pending()).toBe(1);
		const q = readdirSync(join(dir, "queue"));
		expect(q.length).toBe(1);
		const key = q[0]!.replace(".req.json", "");
		writeFileSync(
			join(dir, "answers", `${key}.json`),
			JSON.stringify({ a: 1 }),
		);
		port.reset();
		const r = await port.complete(req, new AbortController().signal);
		expect(r.value).toEqual({ a: 1 });
		expect(r.model).toBe("self");
	});
});
