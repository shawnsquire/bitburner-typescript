/**
 * Brackets Solver
 *
 * Read the open brackets and type the matching closing brackets in reverse order.
 *
 * Detection: h4 contains "Close the brackets".
 */
import { MiniGameSolver } from "/lib/infiltration/types";
import { DomUtils } from "/lib/dom";

const BRACKET_MAP: Record<string, string> = {
  "(": ")",
  "[": "]",
  "{": "}",
  "<": ">",
};

export const bracketsSolver: MiniGameSolver = {
  id: "brackets",
  name: "Close the Brackets",

  detect(doc: Document): boolean {
    const container = doc.querySelector(".MuiContainer-root");
    if (!container) return false;
    const papers = container.querySelectorAll(":scope > .MuiPaper-root");
    const game = papers[papers.length - 1];
    if (!game) return false;

    const h4 = game.querySelector("h4");
    return h4?.textContent?.toLowerCase().includes("close the brackets") ?? false;
  },

  async solve(doc: Document, dom: DomUtils): Promise<void> {
    const container = dom.getGameContainer();
    if (!container) throw new Error("Brackets: game container not found");

    // The brackets are shown in a large Typography element (typically with fontSize ~5em)
    // Contains the left (open) brackets + any already-typed right brackets, followed by a
    // <BlinkingCursor/> that alternates every 1s between "|" and a non-breaking space. Strip both
    // so the match doesn't depend on catching the cursor mid-blink — without this, polling
    // could exhaust its retry window while the cursor happens to be in its "|" phase and
    // never find a match at all.
    // Poll for bracket text — React may not have rendered <p> elements on the first frame
    let bracketText = "";
    for (let attempt = 0; attempt < 20; attempt++) {
      const current = dom.getGameContainer() ?? container;
      const paragraphs = current.querySelectorAll("p");
      for (const p of paragraphs) {
        const text = (p.textContent ?? "").replace(/[\u00a0|]/g, "").trim();
        if (text && /^[([{<)\]}>]+$/.test(text)) {
          bracketText = text;
          break;
        }
      }
      if (bracketText) break;
      await dom.sleep(50);
    }

    if (!bracketText) throw new Error("Brackets: could not find bracket text after 20 retries");

    // Extract only the opening brackets (chars that are in BRACKET_MAP keys)
    const openBrackets: string[] = [];
    for (const ch of bracketText) {
      if (ch in BRACKET_MAP) {
        openBrackets.push(ch);
      }
    }

    // Type closing brackets in reverse order
    for (let i = openBrackets.length - 1; i >= 0; i--) {
      const closingBracket = BRACKET_MAP[openBrackets[i]];
      dom.pressKey(closingBracket);
      await dom.sleep(10);
    }
  },
};
