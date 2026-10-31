/** Awaits `work`, but rejects as soon as the signal aborts even when the work ignores it. */
export const untilAborted = <T>(
	work: Promise<T>,
	signal: AbortSignal,
): Promise<T> => {
	if (signal.aborted) {
		work.catch(() => undefined);
		return Promise.reject(signal.reason ?? new Error("aborted"));
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			work.catch(() => undefined);
			reject(signal.reason ?? new Error("aborted"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		work.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
};
