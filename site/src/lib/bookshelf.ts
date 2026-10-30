import { getCatalog } from './catalog';
import type { Note } from './catalog';

/**
 * 我的书架 · 数据层
 *
 * 「我的书架」只包含微信读书归档的书籍文本（书摘），
 * 「网络博主」只包含微信读书之外的创作者 / 专题合集，二者严格分离。
 *
 * 展示层规则（不修改任何原始 md）：
 * 1. 源 frontmatter 缺 category 的书，按标题关键词兜底归类，做到书架无「未分类」；
 * 2. 所有书目按「最新阅读笔记时间」（lastReadDate → finishedDate → readingDate）
 *    从新到旧排列，网格中即从左到右、从上到下。
 */

/** 未标注分类且兜底规则也未命中的书统一归入「未分类」 */
export const UNCATEGORIZED = '未分类';

/**
 * 分类展示顺序 —— 参考 weread-export-tool/output 导出目录的分类方案，
 * 并按常用度微调，「未分类」固定在最后（正常情况下不会出现）。
 */
export const BOOKSHELF_CATEGORY_ORDER = [
  '文学',
  '社会文化',
  '历史',
  '精品小说',
  '个人成长',
  '计算机',
  '政治军事',
  '哲学宗教',
  '心理',
  '科学技术',
  '教育学习',
  '人物传记',
  '童书',
  '经济理财',
  '医学健康',
  '生活百科',
  UNCATEGORIZED,
];

/**
 * 缺分类书的兜底归类规则（按标题包含关键词匹配，自上而下先命中先生效）。
 * 仅作用于展示层，绝不回写源文件。
 */
const FALLBACK_RULES: Array<[RegExp, string]> = [
  // —— 教育学习 ——
  [/Learn to Read Greek/i, '教育学习'],
  [/研究生论文写作/, '教育学习'],
  [/维克多英语/, '教育学习'],
  [/公文格式/, '教育学习'],
  // —— 精品小说 ——
  [/白鹿原/, '精品小说'],
  // —— 心理 ——
  [/巨婴国/, '心理'],
  // —— 个人成长 ——
  // 「大猿取经」是程序员公众号，自述「写一写自己工作生活中反复思考的东西」，非技术教程
  [/大猿取经/, '个人成长'],
  // —— 计算机 ——
  [/人月神话/, '计算机'],
  // —— 人物传记 ——
  [/只是为了好玩/, '人物传记'],
  // —— 历史 ——
  // 「哦，加拿大（1867-2017）」是加拿大联邦史，按内容归历史（云端给的是「原版书」形式标签，见 FORMAT_CATEGORY_LABELS）
  [/人类大历史|突厥历法|国史大纲|圣杯与剑|中国近代史|加拿大/, '历史'],
  // —— 哲学宗教 ——（刘擎西方现代思想讲义为政治哲学导论；哈特《法律的概念》为法哲学经典）
  [/培根随笔|中国社会中的宗教|信仰与德行|刘擎西方现代思想讲义|法律的概念/, '哲学宗教'],
  // —— 经济理财 ——（「哈佛经济学家推理系列」别名「奇案中的经济学」，以推理小说讲经济学原理，电商归经济通俗读物；
  // 「私产先生」为价格控制 / 经济自由主题经济学公众号；「四十个世纪的工资与价格管制」为经济史）
  [/国家为什么会失败|曼昆经济学|经济学家推理|私产先生|四十个世纪的工资与价格管制/, '经济理财'],
  // —— 政治军事 ——（央视新闻为中央官方时政媒体，与新华社/人民日报同类；「美国反对美国」为王沪宁美国政治观察著作；
  // Rethinking Theories of Governance / 反思治理理论 为治理理论学术书；张千帆《美国立宪启示》为宪法/政治）
  [/新华社|人民日报|央视新闻|政事儿|长安街知事|卢克文|波兰球|半月谈|美国反对美国|Rethinking Theories of Governance|反思治理理论|张千帆/, '政治军事'],
  // —— 文学（书评 / 文学刊物优先于通用报刊规则） ——
  [/人民文学|新京报书评/, '文学'],
  // —— 科学技术 ——（「云海观星社」名为观星，实为半导体/芯片产业科普号）
  [/毕导|云海观星社/, '科学技术'],
  // —— 社会文化（社会学、语言学、公共空间、综合报刊等） ——
  // 「中国新闻网」为综合新闻媒体，与中国新闻周刊 / 北京日报等同类归入社会文化
  [
    /社会学|江村经济|茶馆|强社会与弱国家|理论好用吗|摩登语言学|胭脂与焉支|语言学的邀请|法学教书匠|吉尼斯|账号已迁移|中国新闻周刊|中国新闻社|中国新闻网|北京日报|北京青年报|南方都市报|南风窗|潇湘晨报|中县干部|冯军旗|中信出版/,
    '社会文化',
  ],
];

export interface BookshelfCategory {
  name: string;
  noteCount: number;
  notes: Note[];
}

export interface BookshelfData {
  categories: BookshelfCategory[];
  allBooks: Note[];
  totalBooks: number;
}

/** 书的最新阅读时间排序键（YYYY-MM-DD 可直接字符串比较；缺失排末尾） */
export function bookSortKey(note: Note): string {
  const w = note.weread;
  return w?.lastReadDate?.trim() || w?.finishedDate?.trim() || w?.readingDate?.trim() || '';
}

/** 从新到旧：最新阅读笔记时间降序，同日期以标题稳定兜底 */
export function compareByRecent(left: Note, right: Note): number {
  const lk = bookSortKey(left);
  const rk = bookSortKey(right);
  if (lk !== rk) return rk.localeCompare(lk);
  return left.title.localeCompare(right.title, 'zh-CN');
}

/**
 * 只表示「版本 / 语言形式」而非内容学科的 frontmatter 分类标签（如「原版书-英文原版」）。
 * 命中这类标签时不按它归类——用户要求按书籍内容分类——改走下面的内容关键词兜底规则。
 * 只增不减：以后发现新的形式标签（非学科）就追加进来。
 */
const FORMAT_CATEGORY_LABELS = new Set(['原版书']);

/** 取书摘的父分类（「文学-外国文学」→「文学」），形式标签/缺分类时走内容兜底规则 */
export function bookParentCategory(note: Note): string {
  const full = note.weread?.category?.trim();
  if (full) {
    const parent = full.split('-')[0].trim();
    if (parent && !FORMAT_CATEGORY_LABELS.has(parent)) return parent;
  }

  const title = note.title ?? '';
  for (const [pattern, category] of FALLBACK_RULES) {
    if (pattern.test(title)) return category;
  }
  return UNCATEGORIZED;
}

export async function getBookshelf(): Promise<BookshelfData> {
  const catalog = await getCatalog();

  const books = catalog.notes.filter(
    (note) => note.collectionName === '微信读书' && note.kind === 'book' && !note.draft,
  );

  const grouped = new Map<string, Note[]>();
  for (const note of books) {
    const category = bookParentCategory(note);
    const list = grouped.get(category) ?? [];
    list.push(note);
    grouped.set(category, list);
  }

  // 每个分类内部：最新阅读的书在前
  for (const list of grouped.values()) list.sort(compareByRecent);

  const categories: BookshelfCategory[] = [];
  const added = new Set<string>();

  for (const name of BOOKSHELF_CATEGORY_ORDER) {
    const list = grouped.get(name);
    if (list && list.length > 0) {
      categories.push({ name, noteCount: list.length, notes: list });
      added.add(name);
    }
  }
  for (const [name, list] of grouped) {
    if (!added.has(name)) {
      categories.push({ name, noteCount: list.length, notes: list });
      added.add(name);
    }
  }

  // 「全部」视图：跨分类按最新阅读时间全局从新到旧
  const allBooks = [...books].sort(compareByRecent);

  return { categories, allBooks, totalBooks: books.length };
}
