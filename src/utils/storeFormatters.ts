/**
 * Formatting and sanitization utilities for novel titles, authors, and synopses
 */

/**
 * Strips metadata noise, duplicated tokens, and glued statistics from author names
 */
export function cleanAuthorName(rawAuthor?: string): string {
  if (!rawAuthor) return "Unknown";
  let a = rawAuthor.trim();

  // Decode common HTML entities
  a = a.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");

  // Remove leading prefixes like 作者：, 作者:, author:, by, By, etc.
  a = a.replace(/^(?:作者|作\s*者|author|by)\s*[：:]\s*/i, "");
  a = a.replace(/^by\s+/i, "");
  a = a.replace(/^(?:作者|作\s*者)\s+/i, "");

  // Strip duplicate repeated "作者：" or "作者:"
  a = a.replace(/(?:作者[：:]\s*)+/g, " ");

  // Cut off at common Chinese novel platform metadata boundaries that get glued to author names
  const metadataKeywords = [
    "总书评数",
    "当前被收藏数",
    "被收藏数",
    "收藏数",
    "营养液数",
    "营养液",
    "文章积分",
    "积分",
    "全文字数",
    "总字数",
    "字数",
    "小说简介",
    "内容简介",
    "简介",
    "文案",
    "小说大小",
    "文件大小",
    "大小",
    "状态",
    "类别",
    "分类",
    "更新时间",
    "更新",
    "最新章节",
    "章节",
    "总推荐",
    "推荐数",
    "推荐",
    "总人气",
    "人气",
    "点击数",
    "点击",
    "签约",
    "首发",
    "查看作者其他作品",
    "作品标签",
    "标签",
    "主角",
    "配角",
    "其它",
    "其他",
    "立意",
    "一句话简介",
    "晋江",
    "番茄",
    "长佩",
    "海棠",
    "废文",
    "书友互动",
    "txt分享",
    "下载",
    "完结",
    "连载",
    "VIP",
  ];

  for (const kw of metadataKeywords) {
    const idx = a.indexOf(kw);
    if (idx > 0) {
      a = a.substring(0, idx).trim();
    }
  }

  // Remove trailing " 著" or "著" at the end
  a = a.replace(/\s*著\s*$/g, "");

  // Remove bracketed / parenthetical additions
  a = a.replace(/[\(（\[【].*$/g, "").trim();
  a = a.replace(/[»>]+.*$/g, "").trim();
  a = a.replace(/[_|\-–—\/\\].*$/g, "").trim();

  // If author string is duplicated consecutively, e.g. "凛春风凛春风" or "AlvarosAlvaros"
  if (a.length >= 4 && a.length % 2 === 0) {
    const half = a.slice(0, a.length / 2);
    if (half + half === a) a = half;
  }

  // Remove trailing punctuation or whitespace
  a = a.replace(/^[：:\s]+|[：:\s]+$/g, "").trim();

  // Safety fallback for runaway strings (> 25 chars)
  if (a.length > 25) {
    const firstToken = a.split(/[\s,，、]+/)[0];
    if (firstToken && firstToken.length >= 2 && firstToken.length <= 20) {
      a = firstToken;
    }
  }

  return a || "Unknown";
}

/**
 * Strips promotional headers, raw ranking stats, and teaser prefixes from novel synopses
 */
export function cleanSummaryText(rawSummary?: string): string {
  if (!rawSummary) return "";
  let s = rawSummary.trim();

  // Strip raw Chinese stats header (e.g. 18100次点击 76200海星 文案：... or 总书评数：23007 当前被收藏数：77441...)
  s = s.replace(
    /^[\d,.]+\s*(?:次点击|点击|次阅读|阅读|海星|推荐|收藏|人气|条书评|书评|字|万字)[\s\d,.]*(?:次点击|点击|次阅读|阅读|海星|推荐|收藏|人气|条书评|书评|字|万字)*\s*/gi,
    ""
  );

  // Strip translated English stats header (e.g. 18,100 hits 76,200 Haixing copywriting: ...)
  s = s.replace(
    /^[\d,.]+\s*(?:hits|reads|views|stars|haixing|favorites|reviews|words)[\s\d,.]*(?:hits|reads|views|stars|haixing|favorites|reviews|words)*\s*/gi,
    ""
  );

  // Strip copywriting / synopsis prefixes in Chinese or English
  s = s.replace(/^(?:文案|简介|内容简介|内容标签|作品简介|小说简介|copywriting|synopsis|summary)[：:]\s*/gi, "");

  // If Chinese title/author tags were prefixed in the teaser snippet
  s = s.replace(/^《[^》]+》\s*/, "");
  s = s.replace(/^又名《[^》]+》\s*/, "");
  s = s.replace(/^(?:作者|作\s*者)[：:].*?(?=(?:简介|文案|内容简介|[一1][\.\、]|【|内容标签|正文|\n|$))/s, "");
  s = s.replace(/(?:总书评数|当前被收藏数|收藏数|营养液数|文章积分|总字数|全文字数)[：:]\s*[\d,]+\s*/g, "");
  s = s.replace(/^(?:文案|简介|内容简介|内容标签|作品简介|小说简介|copywriting|synopsis|summary)[：:]\s*/gi, "");

  // Strip promotional/footer noise from Chinese novel scrapers
  s = s.replace(
    /(?:安卓设备推荐浏览器|苹果设备推荐浏览器|推荐浏览器|如果无法下载|大部分下载问题|重要提醒|下载地址|若无法访问|推荐：小说书友|Copyright|爱去小说网|返回顶部).*$/si,
    ""
  );

  return s.trim();
}
