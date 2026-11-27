import type { ProtocolEvent } from '../ProtocolInterface';

const phraseWords = 8;
const historyPhrases = 1600;
const windowPhrases = 160;
const repeatedPhrasesPerWindow = 128;
const consecutiveWindows = 3;
const minCycleWords = 48;
const maxWordLength = 128;

class ReasoningRepetition {
  private trailingWord = '';
  private readonly words: string[] = [];
  private readonly history: string[] = [];
  private readonly lastPosition = new Map<string, number>();
  private position = 0;
  private cycleLength = 0;
  private consecutiveMatches = 0;
  private windowCount = 0;
  private repeatedCount = 0;
  private repeatedWindows = 0;

  push(delta: string): boolean {
    // ACP can split inside a word. Only score words whose delimiter arrived.
    const words = (this.trailingWord + delta).toLowerCase().split(/[^\p{L}\p{N}_'-]+/u);
    this.trailingWord = (words.pop() ?? '').slice(-maxWordLength);
    for (const word of words) {
      if (!word) continue;
      this.words.push(word.slice(-maxWordLength));
      if (this.words.length < phraseWords) continue;

      const phrase = this.words.join(' ');
      this.words.shift();
      const previousPosition = this.lastPosition.get(phrase);
      if (previousPosition !== undefined) this.repeatedCount++;

      const position = this.position++;
      const matchesCycle = this.cycleLength >= minCycleWords
        && this.history[(position - this.cycleLength) % historyPhrases] === phrase;
      const slot = position % historyPhrases;
      const oldest = this.history[slot];
      if (oldest !== undefined && this.lastPosition.get(oldest) === position - historyPhrases) {
        this.lastPosition.delete(oldest);
      }
      this.history[slot] = phrase;
      this.lastPosition.set(phrase, position);

      // Require a full repeat and at least half of the next one, with enough
      // extra matching words to distinguish a loop from revisiting a short phrase.
      const previousDistance = previousPosition === undefined ? 0 : position - previousPosition;
      const distance = matchesCycle ? this.cycleLength : previousDistance;
      if (distance < minCycleWords) {
        this.consecutiveMatches = 0;
      } else {
        this.consecutiveMatches = distance === this.cycleLength ? this.consecutiveMatches + 1 : 1;
        const confirmingWords = Math.max(minCycleWords, Math.ceil(distance / 2));
        if (this.consecutiveMatches >= distance + confirmingWords - (phraseWords - 1)) return true;
      }
      this.cycleLength = distance;

      if (++this.windowCount === windowPhrases) {
        this.repeatedWindows = this.repeatedCount >= repeatedPhrasesPerWindow ? this.repeatedWindows + 1 : 0;
        this.windowCount = 0;
        this.repeatedCount = 0;
        if (this.repeatedWindows === consecutiveWindows) return true;
      }
    }
    return false;
  }
}

export function createVibeReasoningGuard(): (event: ProtocolEvent) => string | undefined {
  let reasoning = new ReasoningRepetition();
  return (event) => {
    if (event.type === 'reasoning' && event.content && reasoning.push(event.content)) {
      return 'Mistral Vibe stopped after repeating its reasoning. Resume with a specific next action based on the current files.';
    }
    if ((event.type === 'text' && event.content?.trim()) || event.type === 'tool_call' || event.type === 'tool_result') {
      reasoning = new ReasoningRepetition();
    }
    return undefined;
  };
}
