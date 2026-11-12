const politicalTerms = new Map([
  [
    "中华人民共和国",
    "Volksrepublik China"
  ],
  [
    "中国共产党",
    "Kommunistische Partei Chinas"
  ],
  [
    "中国国民党",
    "Kuomintang"
  ],
  [
    "中共中央",
    "Zentralkomitee der Kommunistischen Partei Chinas"
  ],
  [
    "共产党",
    "Kommunistische Partei"
  ],
  [
    "中共",
    "Kommunistische Partei Chinas"
  ],
  [
    "习近平",
    "Xi Jinping"
  ],
  [
    "毛泽东",
    "Mao Zedong"
  ],
  [
    "毛主席",
    "Vorsitzender Mao"
  ],
  [
    "文化大革命",
    "Kulturrevolution"
  ],
  [
    "文革",
    "Kulturrevolution"
  ],
  [
    "四人帮",
    "Viererbande"
  ],
  [
    "红卫兵",
    "Rote Garden"
  ],
  [
    "大跃进",
    "Großer Sprung nach vorn"
  ],
  [
    "人民公社",
    "Volkskommune"
  ],
  [
    "法轮功",
    "Falun Gong"
  ],
  [
    "天安门广场",
    "Tian’anmen-Platz"
  ],
  [
    "坦克人",
    "Panzermann"
  ],
  [
    "达赖喇嘛",
    "Dalai Lama"
  ],
  [
    "台湾独立",
    "Unabhängigkeit Taiwans"
  ],
  [
    "台独",
    "Unabhängigkeit Taiwans"
  ],
  [
    "武统台湾",
    "militärisch erzwungene Vereinigung mit Taiwan"
  ],
  [
    "西藏独立",
    "Unabhängigkeit Tibets"
  ],
  [
    "新疆独立",
    "Unabhängigkeit Xinjiangs"
  ],
  [
    "八九民运",
    "Demokratiebewegung von 1989"
  ],
  [
    "六四事件",
    "Tian’anmen-Ereignisse vom 4. Juni 1989"
  ],
  [
    "天安门事件",
    "Tian’anmen-Ereignisse"
  ]
]);

const politicalExpression = /中华人民共和国|中国共产党|中国国民党|文化大革命|天安门广场|天安门事件|中共中央|人民公社|达赖喇嘛|台湾独立|武统台湾|西藏独立|新疆独立|八九民运|六四事件|共产党|习近平|毛泽东|毛主席|四人帮|红卫兵|大跃进|法轮功|坦克人|中共|文革|台独|六四(?=[”」』"的期镇过之])/gu;

/** @param {string} title */
function translateTitleTerms(title) {
  return title.replace(politicalExpression, (term) => politicalTerms.get(term) ?? "Tian’anmen-Ereignisse vom 4. Juni 1989");
}

/**
 * Repair title punctuation inherited from transcript filenames.
 * @param {string} value
 */
export function displayArticleTitle(value) {
  return translateTitleTerms(value)
    .replace(/^(深度|开年献礼)[_＿]{2}/u, '$1｜')
    .replace(/[_＿]+([^_＿\s，。！？｜]+)[_＿]+(?=的|变)/gu, '“$1”')
    .replace(/(?<=变)[_＿]([^_＿\s]+)[_＿]/gu, '“$1”')
    .replace(/\s+[_＿]+\s+/gu, ' · ')
    .replace(/(?<=[\p{Script=Han}\d])\s+-\s+(?=\p{Script=Han})/gu, '：')
    .replace(/[_＿]+(?=[上下]$)/u, '（')
    .replace(/（([上下])$/u, '（$1）')
    .replace(/(?<=[\p{Script=Han}\d])[_＿]+(?=\p{Script=Han})/gu, '，');
}
