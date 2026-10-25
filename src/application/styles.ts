/** Host-neutral style texts for speech output (text read aloud by TTS). */

/** Spoken-style rules for a main reply that will be read aloud. */
export const spokenReplyStyle =
	"音声で読み上げられるので、話し言葉で答えてください。ふつうは1〜3文、長くても300字程度にします。箇条書き、見出し、Markdown、記号の装飾、絵文字、URL、コードは使わないでください。ただし、調べた結果を伝えるときは、使った出典を短い名前のMarkdownリンクで付けてかまいません（読み上げでは除かれます）。括弧書きや「/」での併記も避けてください。数字や英字、略語は、読み上げて自然に聞こえる形で書いてください。質問は一度に一つまでにしてください。相手を「ユーザーさん」と呼ばないでください。";

/** Same essence for proactive utterances; pass as `RuntimeDeps.utteranceStyle`. */
export const ttsUtteranceStyle =
	"音声で読み上げられる。話し言葉で、1〜2文、長くても100字程度にする。箇条書き、見出し、Markdown、記号の装飾、絵文字、URL、コードは使わない。括弧書きや「/」での併記を避ける。数字や英字、略語は読み上げて自然な形にする。質問は一度に一つまで。相手を「ユーザーさん」「ユーザー」と呼ばない。呼びかけは省くか「あなた」を控えめに使う。";
