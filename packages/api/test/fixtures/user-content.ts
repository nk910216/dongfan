/**
 * Sample user input for round-trip tests.
 *
 * One of the three paths allowed to contain CJK characters (spec 13.1).
 * Fixtures only: the rule being tested is precisely that what a parent types
 * is data, stored and returned untouched.
 */
export const USER_CONTENT = {
  nickname: '小葉',
  nicknameWithSpaces: '小 葉 子',
  note: '喝完馬上吐了一點',
  noteWithEmoji: '第一次翻身 \u{1F389}',
  tagName: '夜奶',
  /** One character, but two UTF-16 units. */
  astralCharacter: '\u{1F389}',
} as const;
