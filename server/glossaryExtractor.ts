import { quotaScheduler } from "./quotaScheduler.js";
import { translateWithGoogle } from "./googleTranslate.js";

export interface ExtractedTerm {
  original: string;
  translation: string;
  category: "Character" | "Faction" | "Realm/Skill" | "Location" | "Item" | "General";
  notes?: string;
}

const COMMON_SURNAMES = new Set([
  "李", "王", "张", "刘", "陈", "杨", "赵", "黄", "周", "吴",
  "徐", "孙", "胡", "朱", "高", "林", "何", "郭", "马", "罗",
  "梁", "宋", "郑", "谢", "韩", "唐", "冯", "于", "董", "萧",
  "叶", "陆", "楚", "白", "苏", "方", "顾", "秦", "沈", "姜",
  "龙", "云", "孟", "牧", "石", "莫", "柳", "段", "南", "北"
]);

const COMPOUND_SURNAMES = ["慕容", "欧阳", "东方", "诸葛", "南宫", "独孤", "皇甫", "司马", "夏侯"];

const FACTION_SUFFIXES = ["宗", "门", "派", "帮", "阁", "殿", "峰", "谷", "庄", "府", "宫", "堂", "院", "盟", "族", "教", "会"];
const REALM_KEYWORDS = [
  "练气", "炼气", "筑基", "金丹", "元婴", "化神", "返虚", "合道", "大乘", "渡劫",
  "斗者", "斗师", "大斗师", "斗灵", "斗王", "斗皇", "斗宗", "斗尊", "斗圣", "斗帝",
  "武徒", "武者", "武师", "宗师", "大宗师", "武尊", "武圣", "武帝", "真神", "主神",
  "后天", "先天", "脱凡", "入道", "羽化", "飞升", "不朽", "至尊"
];
const SKILL_SUFFIXES = ["诀", "经", "功", "掌", "剑", "拳", "指", "步", "法", "术", "典", "录", "图", "印"];
const LOCATION_SUFFIXES = ["大陆", "界", "域", "州", "城", "山", "海", "峰", "谷", "荒", "森", "禁地", "秘境", "深渊", "星系"];
const ITEM_SUFFIXES = ["丹", "剑", "刀", "枪", "鼎", "印", "琴", "甲", "袍", "旗", "符", "盘", "珠", "环", "炉", "塔", "钟"];

/**
 * Heuristic Chinese Entity Extractor (Zero-Gemini-Quota Fallback)
 */
export async function extractGlossaryHeuristic(text: string): Promise<ExtractedTerm[]> {
  if (!text || typeof text !== "string") return [];

  const foundTerms = new Map<string, { category: ExtractedTerm["category"]; count: number; notes: string }>();

  // Helper to register
  const register = (term: string, category: ExtractedTerm["category"], notes: string) => {
    const clean = term.trim();
    if (clean.length < 2 || clean.length > 8) return;
    // Skip terms containing punctuation or digits
    if (/[，。！？“”‘’、\s0-9a-zA-Z]/.test(clean)) return;

    const existing = foundTerms.get(clean);
    if (existing) {
      existing.count += 1;
    } else {
      foundTerms.set(clean, { category, count: 1, notes });
    }
  };

  // 1. Scan for Predefined Realms & Cultivation Ranks
  for (const realm of REALM_KEYWORDS) {
    let pos = 0;
    while ((pos = text.indexOf(realm, pos)) !== -1) {
      // Check for compound like "金丹期", "金丹境", "金丹初期"
      const suffix = text.slice(pos + realm.length, pos + realm.length + 2);
      if (suffix.startsWith("期") || suffix.startsWith("境")) {
        register(text.slice(pos, pos + realm.length + 1), "Realm/Skill", "Cultivation Realm");
      } else {
        register(realm, "Realm/Skill", "Cultivation Realm");
      }
      pos += realm.length;
    }
  }

  // 2. Scan for Character Names (Surname + 1 or 2 characters)
  // Look for compound surnames first
  for (const cs of COMPOUND_SURNAMES) {
    let pos = 0;
    while ((pos = text.indexOf(cs, pos)) !== -1) {
      const candidate = text.slice(pos, pos + cs.length + 1); // 3 chars
      const candidate2 = text.slice(pos, pos + cs.length + 2); // 4 chars
      register(candidate, "Character", "Key Character");
      register(candidate2, "Character", "Key Character");
      pos += cs.length;
    }
  }

  // Look for common single surnames
  const tokens = text.match(/[\u4e00-\u9fa5]{2,4}/g) || [];
  for (const token of tokens) {
    const firstChar = token[0];
    if (COMMON_SURNAMES.has(firstChar) && token.length <= 3) {
      register(token, "Character", "Character / Persona");
    }

    // Factions
    for (const fs of FACTION_SUFFIXES) {
      if (token.endsWith(fs) && token.length >= 3) {
        register(token, "Faction", "Sect / Clan / Faction");
      }
    }

    // Skills & Manuals
    for (const ss of SKILL_SUFFIXES) {
      if (token.endsWith(ss) && token.length >= 3) {
        register(token, "Realm/Skill", "Martial Technique / Skill");
      }
    }

    // Locations
    for (const ls of LOCATION_SUFFIXES) {
      if (token.endsWith(ls) && token.length >= 3) {
        register(token, "Location", "Location / World / Realm");
      }
    }

    // Items & Artifacts
    for (const is of ITEM_SUFFIXES) {
      if (token.endsWith(is) && token.length >= 3) {
        register(token, "Item", "Artifact / Spiritual Item");
      }
    }
  }

  // Sort by frequency
  const sorted = Array.from(foundTerms.entries())
    .filter(([_, data]) => data.count >= 2) // appear at least twice
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 30); // Top 30 terms

  // Translate each term into English using Google Translate
  const results: ExtractedTerm[] = [];
  for (const [orig, info] of sorted) {
    try {
      const en = await translateWithGoogle(orig);
      results.push({
        original: orig,
        translation: en || orig,
        category: info.category,
        notes: `${info.notes} (Appears ${info.count}x)`,
      });
    } catch {
      results.push({
        original: orig,
        translation: orig,
        category: info.category,
        notes: info.notes,
      });
    }
  }

  return results;
}

/**
 * Main Auto-Glossary Scanner: Tries Gemini First, Falls Back to Heuristic
 */
export async function autoGenerateNovelGlossary(text: string, novelTitle?: string): Promise<ExtractedTerm[]> {
  if (!text || typeof text !== "string") return [];
  const sample = text.slice(0, 14000);

  // 1. Try Gemini
  try {
    const prompt = `Analyze this Chinese web novel excerpt${novelTitle ? ` from "${novelTitle}"` : ""} and extract key recurring terminology.
Group them accurately into:
- "Character": Main and supporting character names (with accurate Pinyin or romanized name)
- "Faction": Sects, clans, guilds, families, organizations
- "Realm/Skill": Cultivation stages, martial arts, magic spells, techniques
- "Location": Worlds, continents, cities, sacred grounds
- "Item": Weapons, pills, spiritual treasures, talismans
- "General": Important novel-specific concepts

Return a valid JSON array of objects with keys:
"original" (Chinese text, 2-6 chars),
"translation" (clean English translation or capitalized Pinyin),
"category" ("Character" | "Faction" | "Realm/Skill" | "Location" | "Item" | "General"),
"notes" (brief 1-sentence explanation of who/what it is in the story).

Aim for 12 to 25 of the most essential terms.

Excerpt:
"""
${sample}
"""`;

    let responseText = "";
    const { project } = quotaScheduler.selectProject();
    quotaScheduler.acquireProject(project.id);
    try {
      const response = await project.client.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt,
        config: {
          systemInstruction: "You are a Chinese web novel localization and terminology expert. Return valid JSON only.",
          responseMimeType: "application/json",
          temperature: 0.2,
        },
      });
      responseText = response.text || "";
      quotaScheduler.recordSuccess(project.id);
    } catch (apiErr: any) {
      quotaScheduler.recordFailure(project.id, apiErr);
      throw apiErr;
    } finally {
      quotaScheduler.releaseProject(project.id);
    }

    let parsed: any[] = [];
    try {
      parsed = JSON.parse(responseText || "[]");
    } catch {
      const match = responseText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (match && match[1]) {
        parsed = JSON.parse(match[1]);
      }
    }

    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.map((item) => ({
        original: String(item.original || "").trim(),
        translation: String(item.translation || "").trim(),
        category: (["Character", "Faction", "Realm/Skill", "Location", "Item", "General"].includes(item.category)
          ? item.category
          : "General") as ExtractedTerm["category"],
        notes: item.notes ? String(item.notes).trim() : undefined,
      })).filter((t) => t.original && t.translation);
    }
  } catch (err: any) {
    console.warn("Gemini glossary extraction unavailable or rate-limited, using rule-based fallback:", err.message);
  }

  // 2. Fallback to Heuristic Extractor with Google Translate
  return await extractGlossaryHeuristic(sample);
}
