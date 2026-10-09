/**
 * Sample user input for the screen tests.
 *
 * One of the three paths allowed to contain CJK characters (spec 13.1).
 * Fixtures only: what a parent types is data, rendered and sent untouched.
 */
export const USER_CONTENT = {
  nickname: '小葉',
  note: '喝完馬上吐了一點',
  foodName: '南瓜泥',
  milestone: '第一次翻身',
  /** A tag name, which is user input and round-trips byte for byte. */
  tag: '夜奶',
  /** A second tag name, for renaming one to something in Chinese. */
  otherTag: '白天',
} as const;
