/**
 * Sample user input, used to prove that what a parent types survives a
 * round-trip through validation, storage and the API unchanged.
 *
 * This file is one of three places allowed to contain CJK characters
 * (spec 13.1). It holds fixtures only — never logic — because the rule it
 * exists to test is precisely that user data is not treated as code.
 */

export const USER_CONTENT = {
  babyNickname: '小葉',
  nicknameWithSpaces: '小 葉 子',
  note: '喝完馬上吐了一點，下次少一點',
  noteWithEmoji: '第一次翻身 🎉',
  tagNames: ['夜奶', '感冒期間', '副食品嘗試'],
  /** Exactly ten characters, thirty bytes in UTF-8. */
  tenCharacters: '一二三四五六七八九十',
} as const;
