/**
 * 零依赖拼音首字母提取（构建期在 Node 运行）。
 *
 * 原理：现代 Node 自带 full-ICU，`Intl.Collator('zh-CN-u-co-pinyin')`
 * 能让「汉字之间」按拼音排序，但跨脚本比较时汉字恒排在拉丁字母之前，
 * 无法直接用汉字 vs 'A'..'Z' 推断首字母。因此为每个拼音首字母选取一个
 * 「该字母下拼音序最小音节」的代表汉字作为哨兵，目标字与这些哨兵做
 * 汉字间比较，落到哪个哨兵区间即属于哪个首字母。
 *
 * 哨兵均取该首字母最小音节下「ICU 拼音序最小」的常用字
 * （sensitivity:'base' 忽略声调；同音节内部按 ICU 笔画/部件次序，
 * 哨兵必须选该序最小的字，否则同音节里排在它前面的字会被误判到上一个字母）：
 * A 吖(a) B 巴(ba) C 嚓(ca) D 哒(da) E 婀(e) F 发(fa) G 嘎(ga)
 * H 哈(ha) J 讥(ji) K 咖(ka) L 垃(la) M 妈(ma) N 拿(na) O 噢(o)
 * P 趴(pa) Q 七(qi) R 蚺(ran) S 撒(sa) T 他(ta) W 挖(wa) X 夕(xi)
 * Y 丫(ya) Z 匝(za)。拼音无 I/U/V 开头，故跳过。
 *
 * 哨兵表为 2026-10 用本机 ICU（Node 24）对最小音节常用字池实测取最小值
 * 得到；换 Node/ICU 大版本后若出现错分，按同样方式重新实测。
 */

const collator = new Intl.Collator('zh-CN-u-co-pinyin', {
  sensitivity: 'base',
  numeric: true,
});

/** 按拼音序递增排列的「首字母 → 哨兵字」 */
const SENTINELS: ReadonlyArray<readonly [string, string]> = [
  ['A', '吖'],
  ['B', '巴'],
  ['C', '嚓'],
  ['D', '哒'],
  ['E', '婀'],
  ['F', '发'],
  ['G', '嘎'],
  ['H', '哈'],
  ['J', '讥'],
  ['K', '咖'],
  ['L', '垃'],
  ['M', '妈'],
  ['N', '拿'],
  ['O', '噢'],
  ['P', '趴'],
  ['Q', '七'],
  ['R', '蚺'],
  ['S', '撒'],
  ['T', '他'],
  ['W', '挖'],
  ['X', '夕'],
  ['Y', '丫'],
  ['Z', '匝'],
];

const CJK = /[一-鿿]/;

/**
 * ICU 多音字首字母人工修正（仅收录已证实错分的字，最小覆盖）。
 *
 * 哨兵法依赖 ICU 给每个字的「默认拼音」，但多音字在词首的实际读音
 * 可能与 ICU 默认读音不同。已证实案例：
 * - 「阿」（ā / ē）：ICU 把它排在 a 音节序列里异常靠前的位置，
 *   旧哨兵「啊」之下会落进 '#'；现哨兵已改为「吖」可覆盖，但
 *   词首的「阿」（阿姨、阿哥、阿Q、阿博学长）统读 ā，这里显式
 *   钉死归 A，跨 ICU 版本也不回退。
 *
 * 今后再发现按实际读音错分的多音字，按「字 → 首字母」在此补充。
 */
const INITIAL_OVERRIDES: Readonly<Record<string, string>> = {
  阿: 'A',
};

/** 取单个字符的拼音首字母；英文字母转大写；其余返回 '#' */
export function pinyinInitial(char: string): string {
  const ch = Array.from(char)[0] ?? '';
  if (!ch) return '#';
  if (/^[a-zA-Z]$/.test(ch)) return ch.toUpperCase();
  if (!CJK.test(ch)) return '#';

  const override = INITIAL_OVERRIDES[ch];
  if (override) return override;

  let result = '#';
  for (const [letter, sentinel] of SENTINELS) {
    // ch 排在哨兵之后（或相等）说明其拼音首字母不早于该字母
    if (collator.compare(ch, sentinel) >= 0) {
      result = letter;
    } else {
      break;
    }
  }
  return result;
}

/** 取一段文本首个有效字符的拼音首字母 */
export function pinyinInitialOf(text: string): string {
  const first = Array.from(String(text ?? '').trim())[0] ?? '';
  return pinyinInitial(first);
}
