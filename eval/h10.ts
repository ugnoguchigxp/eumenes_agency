/**
 * H10 (plan §P4-a): scripted delegation returns. For a delegated work unit (the ticket id of an
 * autonomous `delegate` tool use), produce the host's `work.returned` observation for one of the
 * scripted outcomes. Delay and interruption are expressed by when / with which status it is fed.
 */
import type { ObservationInput, WorkStatus } from "../src/contracts/model.ts";

export const H10_TEXT: Record<WorkStatus, string> = {
	succeeded: "調査が完了しました。結論と出典をまとめました",
	partial: "一部だけ調べられました。残りは情報源が見つかっていません",
	failed: "調査に失敗しました（情報源にアクセスできませんでした）",
	question: "確認したいことがあります: 対象は先手番だけでよいですか？",
	interrupted: "ユーザーの依頼を優先するため作業を中断しました",
};

export const scriptedReturn = (
	id: string,
	workRef: string,
	status: WorkStatus,
	at: number,
	text: string = H10_TEXT[status],
): ObservationInput => ({
	id,
	kind: "work.returned",
	actor: "tool",
	occurredAt: at,
	text,
	workRef,
	workStatus: status,
});
