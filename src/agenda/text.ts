/**
 * Text checks the agenda agent applies in code: repeats, research themes, questions. Japanese by
 * nature (they match how the model writes); the model never sees them.
 */

/** Text compared for repeats: whitespace and punctuation do not make a sentence new. */
export const normalize = (text: string) =>
	text.replace(/[\s、。，．,.!?！？…・「」『』（）()〜~ー-]/gu, "");

/** Words of a research request that say how, not what: they never make two themes alike. */
const REQUEST_WORDS = [
	"調べてほしい",
	"まとめてほしい",
	"調べて",
	"まとめて",
	"調べ",
	"まとめ",
	"てほしい",
	"ほしい",
	"一覧",
	"結論",
	"について",
	"向けに",
	"ための",
	"など",
	"こと",
	"もの",
	"整理",
	"確認",
	"情報",
	"おすすめ",
	"一文で",
];

const themeBigrams = (text: string) => {
	let t = text.replace(/[\s、。！？!?…・「」『』（）()：:〜~ー-]/gu, "");
	for (const w of REQUEST_WORDS) t = t.split(w).join("");
	const out = new Set<string>();
	for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
	return out;
};

/** Shared character pairs over the smaller side: near 1 when one theme restates the other. */
export const themeOverlap = (a: string, b: string) => {
	const x = themeBigrams(a);
	const y = themeBigrams(b);
	if (x.size === 0 || y.size === 0) return 0;
	let both = 0;
	for (const g of x) if (y.has(g)) both++;
	return both / Math.min(x.size, y.size);
};

/** Sentences long enough to be a statement or a question of their own, normalized. */
export const sentences = (text: string) =>
	text
		.split(/(?<=[。！？!?])/u)
		.map(normalize)
		.filter((x) => x.length >= 8);

/**
 * The text without its sentences already in `said` (normalized, as `sentences` reads them): what
 * is new in it, or "" when nothing is.
 */
export const withoutSaid = (text: string, said: ReadonlySet<string>) =>
	text
		.split(/(?<=[。！？!?])/u)
		.filter((x) => {
			const n = normalize(x);
			return n === "" || n.length < 8 || !said.has(n);
		})
		.join("")
		.trim();

/** Text inside quotes: the user's own words read back ("「有毒ガスが出るの？」という点は…") ask nothing. */
const unquoted = (text: string) =>
	text.replace(/「[^」]*」|『[^』]*』|https?:\/\/\S+/gu, "");

/**
 * Asks the user something, wherever in the text: a "？", a request to tell (聞かせてください,
 * 教えてもらえますか), or a polite question closed with "。" at the end (ありますか。). Read at the
 * end only, a question with a sentence after it went uncounted (the CLI, 2026-11-10: "…大丈夫ですか？
 * 風が直接当たると、温度が安定しにくいこともあるそうです。"); "そうですか。" opening a reply is no
 * question, so the polite form counts only at the end.
 */
export const asksQuestion = (text: string) => {
	const t = unquoted(text);
	return (
		/[？?]/u.test(t) ||
		/(?:聞かせて|教えて)(?:ください|くださいね|ほしい|もらえ|ね[。．]?\s*$)/u.test(
			t,
		) ||
		/(?:です|ます|ません|でしょう|ましょう|ました|でした)か[。．]?\s*[」』）)]*\s*$/u.test(
			t,
		)
	);
};

export const questionMarks = (text: string) =>
	(text.match(/[？?]/gu) ?? []).length;

/** Words a clause may open with that do not change what it says (いや、うーん、ごめん...). */
const FILLER =
	/^(?:いや|いえ|うーん|うーむ|うん|ん+|あー|えー|えっと|まあ|ごめん(?:ね|なさい)?|すみません|ありがとう(?:ございます)?)[ー〜]*\s*/u;

/**
 * A whole clause that says no, maybe after its topic ("道具の話は"); only endings (です, かな,
 * ね...) may follow.
 */
const NO_THANKS = new RegExp(
	`^(?:[^、。]{1,20}?[はも])?(?:${[
		"(?:今|いま|今日|きょう)は(?:いい|いいや|いらない|いらん|ちょっと|結構|けっこう|やめとく|やめておく|遠慮しとく|遠慮しておく)",
		"(?:今|いま)は大丈夫",
		"(?:もう)?(?:いいや|いらない|いらん|いりません|要らない|結構です|けっこうです)",
		"また(?:今度|こんど|そのうち|(?:あと|後)で)(?:で|に|ね|にする|にします)?",
		"今度(?:で|に|ね)",
		"(?:あと|後)で(?:いい|見る|読む|見ます|読みます)",
		"興味(?:が|は)?(?:ない|ありません)",
		"遠慮(?:しとく|しておく|します|しときます|しておきます)",
		"やめと(?:く|きます)",
		"やめてお(?:く|きます)",
		"そのうち(?:ね|で)?",
	].join("|")})(?:です)?(?:かな|かも)?(?:ね|よ|わ|な)?[ー〜]*(?:[笑w]+)?$`,
	"u",
);

/**
 * "Not now" to a question or an offer (今はいいかな, また今度, 結構です...). Kept for hosts (the
 * package exports it); the agent no longer reads it: a list of ways to say no missed "不要です",
 * "見なくていいです", and the plan reads the no in the conversation (review 2026-11-10 evening 3.1).
 * Only read right after the agent asked or offered something. A clause must say no as a whole, so an ordinary answer
 * that shares a word ("それはいいですね", "それは結構好き", "もう大丈夫そう") is not a no.
 */
export const declinesOffer = (text: string) =>
	text
		.split(/[、。，．,.！!？?…\n]+/u)
		.map((c) => c.trim().replace(FILLER, "").trim())
		.some((c) => c !== "" && NO_THANKS.test(c));

/** The earlier name of {@link asksQuestion}, kept for hosts (now read anywhere in the text). */
export const endsWithQuestion = (text: string) => asksQuestion(text);
