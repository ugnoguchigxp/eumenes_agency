/**
 * The light feeling an utterance is said with (spec/emotion-design.md): one emoji per speak,
 * chosen by select from common sense about the situation. A property of the utterance, not
 * agency state: no intensity, no mood, no decay. The host turns it into voice tone and motion.
 */
export const emotions = [
	{ emoji: "🙂", name: "calm", label: "平静" },
	{ emoji: "😊", name: "joy", label: "嬉しい" },
	{ emoji: "😄", name: "enjoyment", label: "楽しんでいる" },
	{ emoji: "😏", name: "wry", label: "苦笑・皮肉まじりの笑い" },
	{ emoji: "🤔", name: "curiosity", label: "好奇心" },
	{ emoji: "👏", name: "admiration", label: "感心" },
	{ emoji: "😌", name: "relief", label: "安心" },
	{ emoji: "😳", name: "shy", label: "照れ" },
	{ emoji: "😮", name: "surprise", label: "驚き" },
	{ emoji: "😕", name: "confusion", label: "困惑" },
	{ emoji: "😢", name: "sadness", label: "悲しい" },
	{ emoji: "🙏", name: "apologetic", label: "申し訳ない" },
	{ emoji: "😟", name: "worry", label: "心配" },
	{ emoji: "😒", name: "dislike", label: "嫌だ" },
	{ emoji: "😠", name: "anger", label: "怒り" },
] as const;

export type EmotionEmoji = (typeof emotions)[number]["emoji"];
export type EmotionName = (typeof emotions)[number]["name"];

export const emotionEmojis = emotions.map((e) => e.emoji) as [
	EmotionEmoji,
	...EmotionEmoji[],
];
export const emotionNames = emotions.map((e) => e.name) as [
	EmotionName,
	...EmotionName[],
];

export const emotionName = (emoji: EmotionEmoji): EmotionName =>
	emotions.find((e) => e.emoji === emoji)!.name;
export const emotionEmoji = (name: EmotionName): EmotionEmoji =>
	emotions.find((e) => e.name === name)!.emoji;
/** "😮驚き" — the emoji with its Japanese label (prompts, judge). */
export const emotionShown = (name: EmotionName): string => {
	const e = emotions.find((x) => x.name === name)!;
	return `${e.emoji}${e.label}`;
};
