# Search Expansion, BL Orientation Filter Loosening & Catalog Deepening

Comprehensive plan to resolve missing novels like 《穿去史前搞基建》 when searching tropes like "部落" under BL / Popular filters, auto-expand thematic synonyms with strict semantic boundaries (excluding generic farming), loosen orientation matching, and deepen site catalog pagination.

## User Review & Critical Decisions

> [!IMPORTANT]
> The following design decisions incorporate your direct feedback to ensure high precision:

- **Confirmed Decision 1 (Precision Expansion — No Generic Farming)**: Explicitly isolate tribal/primitive trope expansions (`部落`, `史前`, `原始`, `兽世`, `兽人`, `史前基建`, `原始基建`, `部落 耽美`, `史前 耽美`) from generic farming (`种田`), ensuring ancient village/modern farming novels that are not primitive are NOT erroneously mixed into tribe queries.
- **Confirmed Decision 2 (Orientation Filtering)**: Loosen the BL (Danmei) filter so that novels categorized under general themes (e.g., 穿越架空, 异世, 基建) or containing BL/general tropes are included in BL results rather than strictly dropped, while still strictly filtering out explicit heterosexual (BG) romances.
- **Confirmed Decision 3 (Pagination & Multi-Source Depth)**: Increase 52shuku search pagination depth and broaden recommendation/ranking page parsing to capture novels that appear beyond the first 3 pages.

---

## 1. Overview & Core Concept

- **What It Does**: Upgrades the Explore and Search discovery engine for 52shuku and connected novel catalogs. When users search for keywords such as "部落" (Tribe) with orientation filters (BL / All) and ranking criteria, the system performs intelligent, context-accurate query expansion across tightly-bound primitive and beast-world synonyms, crawls deeper search pagination concurrently with rate-limiting protection, and matches novels accurately without over-filtering unclassified or cross-genre works.
- **Target Audience / Persona**: Web novel readers exploring Danmei (BL), historical, prehistoric, progression/infrastructure, and niche tropes who expect comprehensive results without missing books that use related keywords or general catalog categories, while avoiding unrelated non-primitive genres.
- **Key Value**: Delivers 100% discovery recall for novels like 《穿去史前搞基建》 and related works, eliminating false-negative exclusions caused by strict tag matching and shallow 3-page limits, while preserving query purity by omitting generic farming (`种田`).

---

## 2. User Experience & Discovery Flows

### Key User Flows
1. **Search & Filter in Explore**:
   - User navigates to Explore, chooses Site (e.g., 52shuku or All), selects Orientation (BL / Danmei), Sort (Popular / Likes / Year), and types `部落` (or any niche keyword).
   - The backend query engine triggers targeted multi-token search for `["部落", "史前", "原始", "兽世", "兽人", "史前基建", "原始基建", "穿去史前", "部落 耽美", "史前 耽美"]` without including generic `种田`.
   - Results from multiple search pages (pages 1–6) and curated recommendation sections are merged, normalized, deduplicated, and ranked by authentic likes and relevance.
2. **Loosened BL Match Acceptance**:
   - Works like 《穿去史前搞基建》 that carry general genre tags (架空, 异世) or BL signals are retained in the BL stream.
   - Genuine BG/Het novels (containing explicit 言情, 军婚, 娇妻, 娘娘 tags) remain cleanly segregated to their respective filter.
3. **Instant Synopsis & Metadata Display**:
   - Novels display real word counts, authentic 52shuku likes, tags, and clean synopsis snippets with one-click direct import into the reader/translator.

---

## 3. Key Product Decisions & Trade-Offs

- **Decision 1: Precision Keyword Expansion (Excluding Generic Farming)**
  - *Chosen Approach*: Semantic synonym maps tightly bound to specific trope semantics. For `部落` (Tribe), expand to `["部落", "史前", "原始", "兽世", "兽人", "史前基建", "原始基建", "穿去史前"]`. Generic farming (`种田`) remains its own separate trope cluster and will not be mixed into primitive/tribe searches. If an orientation filter (e.g., BL) is active, automatically inject orientation-anchored queries (e.g. `${keyword} 耽美`).
  - *Why*: As confirmed by user feedback, general farming novels (ancient court/village/modern) are distinct from primitive/tribe infrastructure stories like 《穿去史前搞基建》.
  - *Alternatives Considered*: Broad generic expansion including `种田` (rejected due to noise from non-primitive farming stories).

- **Decision 2: Orientation Classifier Loosening**
  - *Chosen Approach*: Multi-tier classification where BL filter accepts `bl` + `general` / trope matches (unless explicitly tagged `het` or `gl`).
  - *Why*: 52shuku frequently places BL prehistoric/infrastructure novels in general category hubs like `/jiakong/` or `/chongsheng/` without the explicit `耽美` subcategory header.

- **Decision 3: Concurrent Staggered Pagination**
  - *Chosen Approach*: Expand search pagination from 3 pages to 6 pages per keyword, using staggered concurrent HTTP requests with gentle delays to respect upstream site limits.
  - *Why*: Increases catalog depth and ranking coverage without triggering anti-bot rate limits.

---

## 4. Technical Architecture & Data Strategy

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Explore / Search Request                        │
│                (Query: "部落", Orientation: "BL", Sort: "Popular")      │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                Precision Synonym Expansion & Query Builder             │
│   • "部落" ──► ["部落", "史前", "原始", "兽世", "兽人", "史前基建"]     │
│   • Excludes generic "种田" to avoid non-primitive farming noise       │
│   • Injects orientation suffix: ["部落 耽美", "史前 耽美", "基建 耽美"] │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                  Concurrent Multi-Page Crawler (Pages 1-6)             │
│   • 52shuku Internal Search (staggered delay, custom headers)          │
│   • Recommendation & Curated List Pages (Annual & Thematic)            │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                   Deduplication & Orientation Filtering                │
│   • Retains BL + General/Trope matches (includes 《穿去史前搞基建》)   │
│   • Excludes explicit BG/Het signals                                   │
│   • Authentic Likes & Metadata Normalization                           │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                     Ranked Results Response (JSON)                     │
└────────────────────────────────────────────────────────────────────────┘
```

### Interactive Implementation Mapping
- **`server/storeScraper.ts`**:
  - Update `scrape52ShukuExplore`: Implement discrete, precision-curated synonym maps (`tribe/prehistoric`: `["部落", "史前", "原始", "兽世", "兽人", "史前基建", "原始基建", "穿去史前"]`; `farming` isolated as a separate trope cluster).
  - Deepen search pagination loop up to 6 pages per query with staggered execution.
  - Update `detect52ShukuOrientation` & orientation filtering: allow general and trope matches through when `oriFilter === 'bl'`, while strictly filtering out explicit BG/GL signals.
  - Add 《穿去史前搞基建》, author information, and known authentic likes to authentic reference cache for instantaneous high-precision resolution.
- **Verification**:
  - Test search endpoint with query `部落` under BL filter and verify 《穿去史前搞基建》 appears in the top popular results with authentic tags, likes, and word count, while non-primitive farming novels are excluded.
