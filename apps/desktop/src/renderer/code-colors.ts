import type { CSSProperties } from "react";
import type { GrammarState, HighlighterCore } from "shiki/core";

/** A run of text in one colour. `style` holds `light-dark()` colours for both appearances. */
export type ColoredText = { text: string; style?: CSSProperties };

/** Text larger than this stays plain, so huge logs and data files open quickly. */
export const MAX_COLORED_BYTES = 2 * 1024 * 1024;
/** Lines longer than this, such as minified bundles, stay plain. */
const MAX_COLORED_LINE = 2000;

const NAMES: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  justfile: "just",
  ".env": "dotenv",
};
// Extensions that are not a Shiki language name or alias.
const EXTENSIONS: Record<string, string> = {
  htm: "html",
  h: "c",
  hh: "cpp",
  hpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
};
// Plain text formats that have a Shiki grammar but gain nothing from it.
const PLAIN = new Set(["txt", "text", "log", "csv", "tsv"]);

let highlighter: Promise<HighlighterCore> | undefined;
let languages: Promise<typeof import("shiki/langs")> | undefined;

function loadLanguages() {
  languages ??= import("shiki/langs");
  return languages;
}

/** The Shiki language for a file name, or undefined when the file stays plain. */
export async function languageFor(fileName: string): Promise<string | undefined> {
  const name = fileName.toLowerCase();
  if (NAMES[name]) return NAMES[name];
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  if (!extension || PLAIN.has(extension)) return undefined;
  const wanted = EXTENSIONS[extension] ?? extension;
  const { bundledLanguagesInfo } = await loadLanguages();
  return bundledLanguagesInfo.find((info) => info.id === wanted || info.aliases?.includes(wanted))
    ?.id;
}

async function load(language: string): Promise<HighlighterCore> {
  highlighter ??= Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
    import("shiki/themes/github-light.mjs"),
    import("shiki/themes/github-dark.mjs"),
  ]).then(([{ createHighlighterCore }, { createJavaScriptRegexEngine }, light, dark]) =>
    // The JavaScript engine avoids WebAssembly; `forgiving` leaves the rare unsupported
    // pattern uncoloured instead of failing the whole file.
    createHighlighterCore({
      themes: [light.default, dark.default],
      langs: [],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    }),
  );
  const core = await highlighter;
  if (!core.getLoadedLanguages().includes(language)) {
    const { bundledLanguages } = await loadLanguages();
    await core.loadLanguage(
      (await bundledLanguages[language as keyof typeof bundledLanguages]()).default,
    );
  }
  return core;
}

function style(htmlStyle: Record<string, string>): CSSProperties {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(htmlStyle))
    result[key.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] = value;
  return result as CSSProperties;
}

/**
 * Colours `lines` block by block, calling `onBlock` with each block's index and its
 * coloured lines. Each block continues the previous block's grammar state, and the work
 * yields between blocks so a long file never freezes the window. Stops when `signal`
 * aborts; failures leave the remaining text plain.
 */
export async function colorBlocks(
  lines: readonly string[],
  blockLines: number,
  language: string,
  signal: AbortSignal,
  onBlock: (index: number, colored: ColoredText[][]) => void,
): Promise<void> {
  const core = await load(language);
  let grammarState: GrammarState | undefined;
  for (let first = 0; first < lines.length && !signal.aborted; first += blockLines) {
    const result = core.codeToTokens(lines.slice(first, first + blockLines).join("\n"), {
      lang: language,
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: "light-dark()",
      tokenizeMaxLineLength: MAX_COLORED_LINE,
      ...(grammarState ? { grammarState } : {}),
    });
    grammarState = result.grammarState;
    if (signal.aborted) return;
    onBlock(
      first / blockLines,
      result.tokens.map((line) =>
        line.map((token) => ({
          text: token.content,
          ...(token.htmlStyle ? { style: style(token.htmlStyle) } : {}),
        })),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
