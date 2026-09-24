import React, { useState, useEffect, useMemo } from "react";
import {
  Search,
  Sparkles,
  BookOpen,
  Download,
  Filter,
  Loader2,
  ArrowRight,
  X,
  ExternalLink,
  Globe,
  ChevronDown,
  ChevronUp,
  RotateCcw,
  Star,
  Heart,
  Flame,
  Calendar,
  ThumbsUp,
  Languages,
} from "lucide-react";
import { cleanAuthorName, cleanSummaryText } from "../utils/storeFormatters";

export interface StoreSearchResult {
  id: string;
  title: string;
  author: string;
  titleZh?: string;
  authorZh?: string;
  titleEn?: string;
  authorEn?: string;
  siteId: string;
  siteName: string;
  novelUrl: string;
  latestChapter?: string;
  chapterCount?: number;
  intro?: string;
  introZh?: string;
  introEn?: string;
  coverUrl?: string;
  likes?: number;
  aiquLikes?: number;
  points?: number;
  year?: number;
  status?: string;
  category?: string;
  fileSize?: string;
  rating?: number;
  ratingCount?: number;
}

export interface ChapterItem {
  index: number;
  title: string;
  url: string;
}

export interface StoreNovelDetail {
  title: string;
  author: string;
  siteId: string;
  siteName: string;
  novelUrl: string;
  intro?: string;
  coverUrl?: string;
  chapters: ChapterItem[];
  fileSize?: string;
}

export function formatCleanSiteName(siteId?: string, siteName?: string): string {
  const s = (siteId || siteName || "").toLowerCase();
  if (s.includes("aiqu")) return "aiqu";
  if (s.includes("jjwxc") || s.includes("晋江")) return "jjwxc";
  if (s.includes("52shuku") || s.includes("52")) return "52shuku";
  if (s.includes("fuxsb") || s.includes("腐小说")) return "fuxsb";
  if (s.includes("banxia") || s.includes("半夏")) return "banxia";
  if (s.includes("69shu") || s.includes("69")) return "69shu";
  if (s.includes("sto520") || s.includes("sto") || s.includes("思兔")) return "sto520";
  if (s.includes("shuba") || s.includes("书吧")) return "shuba";
  if (s.includes("hetushu") || s.includes("和图书")) return "hetushu";
  if (s.includes("paoshuba") || s.includes("泡书吧")) return "paoshuba";
  if (s.includes("bxwx") || s.includes("笔下文学")) return "bxwx";
  return (siteName || siteId || "source").replace(/\.(com|vip|net|org|cc|info|me|top|cn)$/i, "").toLowerCase();
}

interface StoreViewProps {
  onImportNovel: (title: string, rawText: string, autoStart?: boolean) => void;
  getAuthHeaders: () => Record<string, string>;
  externalSearchTrigger?: { query: string; site?: string; timestamp: number } | null;
  onOpenReader?: (novel: {
    novelTitle: string;
    author?: string;
    coverUrl?: string;
    novelUrl?: string;
    siteId?: string;
    chapterIndex?: number;
    totalChapters?: number;
    allChapters?: Array<{ title: string; url: string; index?: number }>;
  }) => void;
}

const SUPPORTED_SITES = [
  { id: "all", name: "All Sites", shortName: "All Sites" },
  { id: "aiqu226", name: "aiqu", shortName: "aiqu" },
  { id: "52shuku", name: "52shuku", shortName: "52shuku" },
  { id: "fuxsb", name: "fuxsb", shortName: "fuxsb" },
  { id: "quanben", name: "quanben", shortName: "quanben" },
  { id: "biquge", name: "biquge", shortName: "biquge" },
  { id: "dmxs", name: "dmxs", shortName: "dmxs" },
  { id: "ptwxz", name: "ptwxz", shortName: "ptwxz" },
  { id: "69shuba", name: "69shu", shortName: "69shu" },
  { id: "czbooks", name: "czbooks", shortName: "czbooks" },
  { id: "uukanshu", name: "uukanshu", shortName: "uukanshu" },
  { id: "sto", name: "sto520", shortName: "sto520" },
];

const POPULAR_SEARCHES = [
  "末世",
  "蜜桃咬一口",
  "鹿灵",
  "听夏",
  "含栀",
  "诡秘之主",
  "道诡异仙",
];

const STORE_STATE_KEY = "megatext_store_state_v3";

interface SavedStoreState {
  query: string;
  selectedSite: string;
  sortBy?: "likes" | "aiquLikes" | "year" | "points" | "relevance";
  results: StoreSearchResult[];
  hasSearched: boolean;
  selectedNovel: StoreNovelDetail | null;
  startChapter: number;
  endChapter: number;
}

const getSavedStoreState = (): Partial<SavedStoreState> => {
  try {
    sessionStorage.removeItem("megatext_store_state_v1");
    sessionStorage.removeItem("megatext_store_state_v2");
    localStorage.removeItem("megatext_store_state_v1");
    localStorage.removeItem("megatext_store_state_v2");

    const raw = sessionStorage.getItem(STORE_STATE_KEY) || localStorage.getItem(STORE_STATE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.results)) {
        parsed.results = parsed.results.map((r: any) => {
          if (r.aiquLikes !== undefined && (r.aiquLikes <= 0 || r.aiquLikes > 10000)) {
            delete r.aiquLikes;
          }
          return r;
        });
      }
      return parsed;
    }
  } catch (e) {
    console.error("Failed to read saved store state:", e);
  }
  return {};
};

// Format points display accurately (unshortened with exact commas per requirement)
function formatPoints(pts?: number): string {
  if (!pts || pts <= 0) return "";
  return `${pts.toLocaleString()} pts`;
}

// Format authentic Aiqu community votes
function formatAiquVotes(votes?: number): string {
  if (!votes || votes <= 0 || votes > 10000) return "";
  return `${votes.toLocaleString()} likes`;
}

// Format likes display accurately
function formatLikes(likes?: number): string {
  if (!likes || likes <= 0) return "";
  if (likes >= 1000000) {
    return `${(likes / 1000000).toFixed(2)}M likes`;
  }
  if (likes >= 1000) {
    return `${(likes / 1000).toFixed(1)}k likes`;
  }
  return `${likes.toLocaleString()} likes`;
}

export const StoreView: React.FC<StoreViewProps> = ({
  onImportNovel,
  getAuthHeaders,
  externalSearchTrigger,
  onOpenReader,
}) => {
  const savedState = getSavedStoreState();

  const [query, setQuery] = useState<string>(savedState.query || "");
  const [selectedSite, setSelectedSite] = useState<string>(savedState.selectedSite || "all");
  const [sortBy, setSortBy] = useState<"likes" | "aiquLikes" | "year" | "points" | "relevance">(
    savedState.sortBy || "likes"
  );
  const [isSearching, setIsSearching] = useState(false);
  const [results, setResults] = useState<StoreSearchResult[]>(savedState.results || []);
  const [hasSearched, setHasSearched] = useState<boolean>(savedState.hasSearched || false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Synopsis dropdown toggle state
  const [expandedSummaryIds, setExpandedSummaryIds] = useState<Record<string, boolean>>({});
  const [loadingIntroIds, setLoadingIntroIds] = useState<Record<string, boolean>>({});

  const toggleSummary = async (novel: StoreSearchResult) => {
    const id = novel.id;
    const isCurrentlyExpanded = !!expandedSummaryIds[id];

    // Toggle UI expansion immediately
    setExpandedSummaryIds((prev) => ({
      ...prev,
      [id]: !isCurrentlyExpanded,
    }));

    // If expanding and intro is short or ends with ellipsis, fetch full synopsis
    const curIntro = novel.introZh || novel.intro || "";
    const isTruncated = curIntro.endsWith("...") || curIntro.endsWith("…") || curIntro.length < 180;

    if (!isCurrentlyExpanded && isTruncated && !loadingIntroIds[id]) {
      setLoadingIntroIds((prev) => ({ ...prev, [id]: true }));
      try {
        const res = await fetch("/api/store/full-intro", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...getAuthHeaders(),
          },
          body: JSON.stringify({
            novelUrl: novel.novelUrl,
            siteId: novel.siteId,
            title: novel.title,
            author: novel.author,
          }),
        });

        if (res.ok) {
          const data = await res.json();
          if (data.success && (data.introZh || data.introEn)) {
            setResults((prev) =>
              prev.map((it) => {
                if (it.id === id || it.novelUrl === novel.novelUrl) {
                  return {
                    ...it,
                    introZh: data.introZh || it.introZh,
                    introEn: data.introEn || it.introEn,
                    intro: data.intro || it.intro,
                    authorZh: cleanAuthorName(data.author || it.authorZh),
                    author: cleanAuthorName(data.author || it.author),
                    fileSize: data.fileSize || it.fileSize,
                  };
                }
                return it;
              })
            );
          }
        }
      } catch (e) {
        // Fallback gracefully
      } finally {
        setLoadingIntroIds((prev) => ({ ...prev, [id]: false }));
      }
    }
  };

  // Keyword highlighting
  const renderHighlightedText = (text: string, search: string) => {
    if (!text) return "";
    const term = search.trim();
    if (!term) return text;

    const parts = text.split(new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"));
    return (
      <>
        {parts.map((part, i) =>
          part.toLowerCase() === term.toLowerCase() ? (
            <span
              key={i}
              className="bg-amber-200 dark:bg-amber-900/60 text-amber-950 dark:text-amber-200 font-bold px-0.5 rounded-xs"
            >
              {part}
            </span>
          ) : (
            part
          )
        )}
      </>
    );
  };

  // Handle external search trigger from Explore tab
  useEffect(() => {
    if (externalSearchTrigger && externalSearchTrigger.query) {
      const targetSite = externalSearchTrigger.site || "aiqu226";
      setQuery(externalSearchTrigger.query);
      setSelectedSite(targetSite);
      handleSearch(externalSearchTrigger.query, targetSite);
    }
  }, [externalSearchTrigger]);

  // Novel detail & chapter selection state
  const [selectedNovel, setSelectedNovel] = useState<StoreNovelDetail | null>(savedState.selectedNovel || null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  // Language toggle state: cardId -> boolean (false = English translated (default), true = original Chinese)
  const [chineseModeCards, setChineseModeCards] = useState<Record<string, boolean>>({});

  const toggleCardLanguage = (cardId: string) => {
    setChineseModeCards((prev) => ({
      ...prev,
      [cardId]: !prev[cardId],
    }));
  };

  // Chapter range selection
  const [startChapter, setStartChapter] = useState<number>(savedState.startChapter || 1);
  const [endChapter, setEndChapter] = useState<number>(savedState.endChapter || 100);
  const [isScraping, setIsScraping] = useState(false);
  const [scrapeProgress, setScrapeProgress] = useState<string | null>(null);
  const [scrapeElapsedSec, setScrapeElapsedSec] = useState(0);

  // Live timer during chapter download to reassure user it is actively progressing
  useEffect(() => {
    let timer: any = null;
    if (isScraping) {
      setScrapeElapsedSec(0);
      timer = setInterval(() => {
        setScrapeElapsedSec((prev) => prev + 1);
      }, 1000);
    } else {
      setScrapeElapsedSec(0);
    }
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [isScraping]);

  // Persist state across tab navigation
  useEffect(() => {
    try {
      const stateToSave: SavedStoreState = {
        query,
        selectedSite,
        sortBy,
        results,
        hasSearched,
        selectedNovel,
        startChapter,
        endChapter,
      };
      const json = JSON.stringify(stateToSave);
      sessionStorage.setItem(STORE_STATE_KEY, json);
      localStorage.setItem(STORE_STATE_KEY, json);
    } catch (e) {
      // ignore
    }
  }, [query, selectedSite, sortBy, results, hasSearched, selectedNovel, startChapter, endChapter]);

  // Handle novel search submit
  const handleSearch = async (searchQuery: string, targetSite = selectedSite) => {
    const q = searchQuery.trim();
    if (!q) return;

    setIsSearching(true);
    setErrorMessage(null);
    setHasSearched(true);
    setSelectedNovel(null);

    try {
      const siteParam = targetSite || "all";
      const res = await fetch(
        `/api/store/search?q=${encodeURIComponent(q)}&site=${encodeURIComponent(siteParam)}`,
        {
          headers: getAuthHeaders(),
        }
      );
      if (!res.ok) {
        throw new Error(`Search failed (${res.status})`);
      }
      const data = await res.json();
      const searchResults: StoreSearchResult[] = data.results || [];
      setResults(searchResults);
    } catch (err: any) {
      console.error("Store search error:", err);
      setErrorMessage("Could not connect to novel search engine. Please try again.");
      setResults([]);
    } finally {
      setIsSearching(false);
    }
  };

  // Clear search and reset state
  const handleClearSearch = () => {
    setQuery("");
    setResults([]);
    setHasSearched(false);
    setSelectedNovel(null);
    setErrorMessage(null);
    try {
      sessionStorage.removeItem(STORE_STATE_KEY);
      localStorage.removeItem(STORE_STATE_KEY);
    } catch {}
  };

  // Open novel detail modal and fetch chapters
  const handleSelectNovel = async (novel: StoreSearchResult) => {
    setIsLoadingDetail(true);
    setErrorMessage(null);

    try {
      const res = await fetch("/api/store/fetch-toc", {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({
          novelUrl: novel.novelUrl,
          siteId: novel.siteId,
          title: novel.title,
          author: novel.author,
          intro: novel.intro,
          coverUrl: novel.coverUrl,
          fileSize: novel.fileSize,
        }),
      });
      if (!res.ok) {
        throw new Error(`Failed to load novel TOC (${res.status})`);
      }
      const data: StoreNovelDetail = await res.json();
      const resolvedTitle =
        data.title && data.title !== "Untitled Novel" ? data.title : novel.title;
      const resolvedAuthor =
        data.author && data.author !== "Unknown" && data.author !== "Unknown Author"
          ? data.author
          : novel.author;
      const resolvedIntro =
        data.intro && data.intro !== "No summary available."
          ? data.intro
          : novel.intro || data.intro;
      const resolvedChapters = Array.isArray(data.chapters) ? data.chapters : [];

      const resolvedDetail: StoreNovelDetail = {
        ...data,
        title: resolvedTitle,
        author: resolvedAuthor,
        intro: resolvedIntro,
        coverUrl: data.coverUrl || novel.coverUrl,
        fileSize: data.fileSize || novel.fileSize,
        chapters: resolvedChapters,
      };

      setSelectedNovel(resolvedDetail);
      setStartChapter(1);
      setEndChapter(resolvedChapters.length > 0 ? resolvedChapters.length : 100);
    } catch (err: any) {
      console.error("Fetch TOC error:", err);
      setSelectedNovel({
        title: novel.title,
        author: novel.author,
        siteId: novel.siteId,
        siteName: novel.siteName,
        novelUrl: novel.novelUrl,
        intro: novel.intro,
        coverUrl: novel.coverUrl,
        fileSize: novel.fileSize,
        chapters: [],
      });
      setStartChapter(1);
      setEndChapter(100);
    } finally {
      setIsLoadingDetail(false);
    }
  };

  // Import novel chapters into translation queue
  const handleStartImport = async (autoStartTranslation: boolean = false) => {
    if (!selectedNovel) return;

    setIsScraping(true);
    setScrapeProgress(
      autoStartTranslation
        ? "Fetching chapters & queuing instant 1-click cloud translation..."
        : "Fetching and compiling raw Chinese text chapters..."
    );

    try {
      const res = await fetch("/api/store/import-novel", {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({
          novelUrl: selectedNovel.novelUrl,
          siteId: selectedNovel.siteId,
          title: selectedNovel.title,
          startChapter,
          endChapter,
          chapters: selectedNovel.chapters,
        }),
      });

      if (!res.ok) {
        throw new Error(`Import failed with status ${res.status}`);
      }

      const data = await res.json();
      if (!data.rawText || !data.rawText.trim()) {
        throw new Error("No readable raw text found in selected chapters.");
      }

      onImportNovel(
        `${selectedNovel.title}_Ch${startChapter}_to_${endChapter}.txt`,
        data.rawText,
        autoStartTranslation
      );
    } catch (err: any) {
      console.error("Import error:", err);
      setErrorMessage(err.message || "Failed to import novel chapters.");
      setIsScraping(false);
    }
  };

  // Filter and Sort results
  const filteredAndSortedResults = useMemo(() => {
    let items = selectedSite === "all" ? [...results] : results.filter((r) => r.siteId === selectedSite);

    // Apply Sorting
    if (sortBy === "likes") {
      items.sort((a, b) => {
        const diff = (b.likes || 0) - (a.likes || 0);
        if (diff !== 0) return diff;
        const pDiff = (b.points || 0) - (a.points || 0);
        if (pDiff !== 0) return pDiff;
        if (a.rating !== undefined || b.rating !== undefined) {
          const aR = a.rating ?? 0;
          const bR = b.rating ?? 0;
          if (bR !== aR) return bR - aR;
          return (b.ratingCount || 0) - (a.ratingCount || 0);
        }
        return (b.year || 0) - (a.year || 0);
      });
    } else if (sortBy === "aiquLikes") {
      items.sort((a, b) => {
        const aVal = (a.aiquLikes && a.aiquLikes <= 10000) ? a.aiquLikes : 0;
        const bVal = (b.aiquLikes && b.aiquLikes <= 10000) ? b.aiquLikes : 0;
        const diff = bVal - aVal;
        if (diff !== 0) return diff;
        const lDiff = (b.likes || 0) - (a.likes || 0);
        if (lDiff !== 0) return lDiff;
        const pDiff = (b.points || 0) - (a.points || 0);
        if (pDiff !== 0) return pDiff;
        return (b.year || 0) - (a.year || 0);
      });
    } else if (sortBy === "year") {
      items.sort((a, b) => (b.year || 0) - (a.year || 0));
    } else if (sortBy === "points") {
      items.sort((a, b) => {
        if ((a.points || 0) === 0 && (b.points || 0) === 0 && (a.rating !== undefined || b.rating !== undefined)) {
          const aR = a.rating ?? 0;
          const bR = b.rating ?? 0;
          if (bR !== aR) return bR - aR;
          return (b.ratingCount || 0) - (a.ratingCount || 0);
        }
        const diff = (b.points || 0) - (a.points || 0);
        if (diff !== 0) return diff;
        const lDiff = (b.likes || 0) - (a.likes || 0);
        if (lDiff !== 0) return lDiff;
        if (a.rating !== undefined || b.rating !== undefined) {
          const aR = a.rating ?? 0;
          const bR = b.rating ?? 0;
          if (bR !== aR) return bR - aR;
          return (b.ratingCount || 0) - (a.ratingCount || 0);
        }
        return (b.year || 0) - (a.year || 0);
      });
    }

    return items;
  }, [results, selectedSite, sortBy]);

  // Counts per site
  const getSiteCount = (siteId: string) => {
    if (siteId === "all") return results.length;
    return results.filter((r) => r.siteId === siteId).length;
  };

  const selectedSiteObj = SUPPORTED_SITES.find((s) => s.id === selectedSite) || SUPPORTED_SITES[0];

  return (
    <div id="store-view-container" className="flex flex-col gap-5 w-full">
      {/* Header Banner */}
      <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-purple-700 via-indigo-800 to-slate-900 p-6 text-white shadow-xl">
        <div className="relative z-10 flex flex-col gap-2">
          <div className="inline-flex items-center gap-2 rounded-full bg-white/15 px-3 py-1 text-xs font-semibold backdrop-blur-md w-fit text-purple-200">
            <Sparkles className="h-3.5 w-3.5" />
            <span>Web Novel Store & Scraper Engine</span>
          </div>
          <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-white">
            Search & Import Chinese Web Novels
          </h2>
          <p className="text-xs sm:text-sm text-purple-200/90 max-w-lg leading-relaxed">
            Directly search across <span className="text-white font-medium">aiqu226.com (爱去小说), 52shuku.vip, fuxsb.com, quanben.io, biquge, dmxs.org, ptwxz.com, 69shuba, czbooks, uukanshu, and sto.cx</span> and import raw text straight into your translation queue.
          </p>
        </div>
      </div>

      {/* Target Site Selector */}
      <div className="flex flex-col gap-2 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 p-3 shadow-xs">
        <div className="flex items-center justify-between text-xs font-semibold text-slate-700 dark:text-slate-300">
          <div className="flex items-center gap-1.5">
            <Globe className="h-4 w-4 text-purple-600 dark:text-purple-400" />
            <span>Choose Target Site:</span>
            <span className="text-purple-600 dark:text-purple-400 font-bold ml-1">
              {selectedSiteObj.name}
            </span>
          </div>
          {hasSearched && (
            <button
              type="button"
              onClick={handleClearSearch}
              className="text-[11px] text-slate-400 hover:text-purple-600 dark:hover:text-purple-400 flex items-center gap-1 font-medium transition cursor-pointer"
            >
              <RotateCcw className="h-3 w-3" />
              <span>Reset Search</span>
            </button>
          )}
        </div>

        {/* Site Filter Tabs */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 no-scrollbar">
          {SUPPORTED_SITES.map((site) => {
            const count = getSiteCount(site.id);
            const isSelected = selectedSite === site.id;
            return (
              <button
                key={site.id}
                type="button"
                onClick={() => {
                  setSelectedSite(site.id);
                  if (query.trim() && hasSearched && results.length === 0) {
                    handleSearch(query, site.id);
                  }
                }}
                className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition cursor-pointer shrink-0 ${
                  isSelected
                    ? "bg-purple-600 text-white shadow-sm ring-2 ring-purple-400/30"
                    : hasSearched && count > 0
                    ? "bg-purple-50/90 dark:bg-slate-800 border border-purple-200 dark:border-purple-800 text-purple-900 dark:text-purple-200 hover:border-purple-400"
                    : "bg-slate-50 dark:bg-slate-800/60 border border-slate-200/90 dark:border-slate-800 text-slate-600 dark:text-slate-400 hover:border-purple-300 hover:text-purple-600"
                }`}
              >
                <span>{site.name}</span>
                {hasSearched && (
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                      isSelected
                        ? "bg-white/20 text-white"
                        : count > 0
                        ? "bg-purple-200/70 dark:bg-purple-900/70 text-purple-800 dark:text-purple-200"
                        : "bg-slate-200/70 dark:bg-slate-700 text-slate-400"
                    }`}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Search Input Box */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleSearch(query, selectedSite);
        }}
        className="flex flex-col gap-3"
      >
        <div className="relative flex items-center shadow-md rounded-2xl bg-white dark:bg-slate-900 border border-purple-200/80 dark:border-purple-900/40 p-1.5 focus-within:ring-2 focus-within:ring-purple-500 transition-all">
          {/* Site Selector Dropdown inside Search Bar */}
          <div className="relative shrink-0 flex items-center pl-2 pr-1 border-r border-slate-200 dark:border-slate-800">
            <select
              value={selectedSite}
              onChange={(e) => {
                const newSite = e.target.value;
                setSelectedSite(newSite);
              }}
              className="appearance-none bg-transparent text-xs font-semibold text-purple-700 dark:text-purple-300 pr-5 py-1.5 focus:outline-none cursor-pointer max-w-[120px] sm:max-w-[170px] truncate"
            >
              {SUPPORTED_SITES.map((s) => (
                <option key={s.id} value={s.id} className="bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100">
                  {s.name}
                </option>
              ))}
            </select>
            <ChevronDown className="h-3.5 w-3.5 text-purple-500 absolute right-1 pointer-events-none" />
          </div>

          <Search className="h-4 w-4 text-purple-500 ml-2 shrink-0 hidden sm:block" />
          <input
            id="store-search-input"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              selectedSite === "all"
                ? "Search across all sites (e.g. 末世, 纯爱, 鹿灵)..."
                : `Search in ${selectedSiteObj.name}...`
            }
            className="w-full bg-transparent px-3 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none"
          />

          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1 mr-1 transition cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          )}

          <button
            id="store-search-button"
            type="submit"
            disabled={isSearching || !query.trim()}
            className="inline-flex items-center gap-1.5 rounded-xl bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white font-semibold text-xs px-4 py-2.5 transition shrink-0 cursor-pointer shadow-sm"
          >
            {isSearching ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="hidden sm:inline">Searching...</span>
              </>
            ) : (
              <>
                <span>Search</span>
                <ArrowRight className="h-3.5 w-3.5" />
              </>
            )}
          </button>
        </div>

        {/* Quick Search Badges */}
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 px-1">
          <span className="font-semibold text-purple-600 dark:text-purple-400">Popular:</span>
          {POPULAR_SEARCHES.map((term) => (
            <button
              key={term}
              type="button"
              onClick={() => {
                setQuery(term);
                handleSearch(term, selectedSite);
              }}
              className="rounded-lg bg-purple-50 dark:bg-slate-800 border border-purple-100 dark:border-slate-700 px-2.5 py-1 text-slate-700 dark:text-slate-300 hover:border-purple-300 hover:text-purple-600 transition cursor-pointer"
            >
              {term}
            </button>
          ))}
        </div>
      </form>

      {/* Sort Bar */}
      {hasSearched && results.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 p-3 rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/30 text-xs">
          <div className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400 font-medium">
            <Filter className="h-3.5 w-3.5 text-purple-600" />
            <span>
              Found <strong className="text-slate-900 dark:text-slate-100">{filteredAndSortedResults.length}</strong> matching novels
            </span>
          </div>

          {/* Sorting Buttons */}
          <div className="flex items-center gap-1.5 overflow-x-auto py-1 max-w-full no-scrollbar">
            <span className="text-slate-400 text-[11px] mr-1 hidden sm:inline shrink-0">Sort by:</span>
            <button
              type="button"
              onClick={() => setSortBy("likes")}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold transition shrink-0 cursor-pointer ${
                sortBy === "likes"
                  ? "bg-rose-500 text-white shadow-xs font-bold"
                  : "bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:border-rose-300"
              }`}
            >
              <Flame className="h-3 w-3" />
              <span>Summary Likes</span>
            </button>

            <button
              type="button"
              onClick={() => setSortBy("aiquLikes")}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold transition shrink-0 cursor-pointer ${
                sortBy === "aiquLikes"
                  ? "bg-emerald-600 text-white shadow-xs font-bold"
                  : "bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:border-emerald-300"
              }`}
            >
              <ThumbsUp className="h-3 w-3" />
              <span>Aiqu Votes (赞)</span>
            </button>

            <button
              type="button"
              onClick={() => setSortBy("year")}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold transition shrink-0 cursor-pointer ${
                sortBy === "year"
                  ? "bg-indigo-600 text-white shadow-xs font-bold"
                  : "bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:border-indigo-300"
              }`}
            >
              <Calendar className="h-3 w-3" />
              <span>Year (Newest)</span>
            </button>

            <button
              type="button"
              onClick={() => setSortBy("points")}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold transition shrink-0 cursor-pointer ${
                sortBy === "points"
                  ? "bg-amber-500 text-white shadow-xs font-bold"
                  : "bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:border-amber-300"
              }`}
            >
              <Star className="h-3 w-3" />
              <span>Points</span>
            </button>

            <button
              type="button"
              onClick={() => setSortBy("relevance")}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold transition shrink-0 cursor-pointer ${
                sortBy === "relevance"
                  ? "bg-purple-600 text-white shadow-xs font-bold"
                  : "bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:border-purple-300"
              }`}
            >
              <span>Relevance</span>
            </button>
          </div>
        </div>
      )}

      {/* Error Notice */}
      {errorMessage && (
        <div className="rounded-2xl border border-rose-300 bg-rose-50 dark:bg-rose-950/40 p-4 text-xs text-rose-700 dark:text-rose-300 flex items-center justify-between">
          <span>{errorMessage}</span>
          <button onClick={() => setErrorMessage(null)} className="text-rose-500 hover:text-rose-700 font-bold ml-2">
            ✕
          </button>
        </div>
      )}

      {/* Search Results List */}
      {isSearching ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-slate-400">
          <Loader2 className="h-8 w-8 animate-spin text-purple-600" />
          <p className="text-xs font-medium">
            {selectedSite === "all"
              ? "Scanning across 11 web novel libraries in parallel..."
              : `Searching ${selectedSiteObj.name}...`}
          </p>
        </div>
      ) : hasSearched && filteredAndSortedResults.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 rounded-3xl border border-dashed border-slate-200 dark:border-slate-800 p-8 text-center gap-3">
          <BookOpen className="h-10 w-10 text-purple-400 dark:text-purple-500" />
          {selectedSite !== "all" && results.length > 0 ? (
            <div className="flex flex-col items-center gap-2">
              <h3 className="font-semibold text-slate-800 dark:text-slate-200 text-sm">
                No direct matches found on {selectedSiteObj.name} for "{query}"
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md">
                We found <strong className="text-purple-600 dark:text-purple-400">{results.length} novels</strong> across other supported sites.
              </p>
              <button
                type="button"
                onClick={() => setSelectedSite("all")}
                className="mt-2 inline-flex items-center gap-1.5 rounded-xl bg-purple-600 hover:bg-purple-700 text-white px-4 py-2 text-xs font-semibold shadow-sm transition cursor-pointer"
              >
                <span>View All {results.length} Results</span>
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : selectedSite !== "all" ? (
            <div className="flex flex-col items-center gap-2">
              <h3 className="font-semibold text-slate-700 dark:text-slate-300 text-sm">
                No novels found on {selectedSiteObj.name} for "{query}"
              </h3>
              <p className="text-xs text-slate-400 max-w-xs">
                Try searching across all libraries to find matches on other mirrors!
              </p>
              <button
                type="button"
                onClick={() => {
                  setSelectedSite("all");
                  handleSearch(query, "all");
                }}
                className="mt-2 inline-flex items-center gap-1.5 rounded-xl bg-purple-600 hover:bg-purple-700 text-white px-4 py-2 text-xs font-semibold shadow-sm transition cursor-pointer"
              >
                <Globe className="h-3.5 w-3.5" />
                <span>Search All Sites For "{query}"</span>
              </button>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-1">
              <h3 className="font-semibold text-slate-700 dark:text-slate-300 text-sm">No novels found for "{query}"</h3>
              <p className="text-xs text-slate-400 max-w-xs">
                Try searching with Chinese characters, author names (e.g. 鹿灵), or novel titles!
              </p>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3.5">
          {filteredAndSortedResults.map((novel, index) => {
            const isExpanded = !!expandedSummaryIds[novel.id];
            const isCardZh = !!chineseModeCards[novel.id];
            const cardTitle = isCardZh ? (novel.titleZh || novel.title) : (novel.titleEn || novel.title);
            const cardAuthor = cleanAuthorName(isCardZh ? (novel.authorZh || novel.author) : (novel.authorEn || novel.author));
            const cardIntro = isCardZh ? (novel.introZh || novel.intro) : (novel.introEn || novel.intro);
            const displayIntro = cleanSummaryText(cardIntro) || "No synopsis available.";
            const isLongIntro = displayIntro.length > 70 || displayIntro.includes("\n") || displayIntro.endsWith("...") || displayIntro.endsWith("…");
            const isLoadingThisIntro = !!loadingIntroIds[novel.id];

            return (
              <div
                key={novel.id}
                className="flex flex-col rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3.5 sm:p-4 shadow-xs hover:shadow-md hover:border-purple-300 dark:hover:border-purple-700/60 transition group"
              >
                {/* Header Pills Row */}
                <div className="flex flex-wrap items-center justify-between gap-1.5 mb-2">
                  <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                    <span className="inline-flex h-5 min-w-[20px] px-1.5 items-center justify-center rounded-md bg-purple-100 dark:bg-purple-900/60 text-[10px] font-bold text-purple-700 dark:text-purple-300">
                      #{index + 1}
                    </span>

                    <span className="inline-flex items-center rounded-md bg-purple-50 dark:bg-purple-950/60 border border-purple-100 dark:border-purple-900 px-1.5 py-0.5 text-[10px] font-semibold text-purple-600 dark:text-purple-300">
                      {formatCleanSiteName(novel.siteId, novel.siteName)}
                    </span>

                    {novel.category && (
                      <span className="inline-flex items-center rounded-md bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 dark:text-slate-300">
                        {novel.category}
                      </span>
                    )}

                    {novel.status && (
                      <span className="inline-flex items-center rounded-md bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-800 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700 dark:text-emerald-300">
                        {novel.status === "完结" ? "✅ 完结" : novel.status}
                      </span>
                    )}

                    {novel.year && (
                      <span className="inline-flex items-center rounded-md bg-indigo-50 dark:bg-indigo-950/60 border border-indigo-200 dark:border-indigo-900/40 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700 dark:text-indigo-300">
                        📅 {novel.year}
                      </span>
                    )}
                  </div>

                  {/* Rating, Likes, Points and Translate Button */}
                  <div className="flex items-center gap-1.5 shrink-0">
                    {/* Translate Icon Button */}
                    <button
                      type="button"
                      onClick={() => toggleCardLanguage(novel.id)}
                      title={isCardZh ? "Switch back to English translation" : "Show original Chinese text (中文)"}
                      aria-label={isCardZh ? "Switch to English" : "Switch to Chinese"}
                      className={`p-1 rounded-md border transition cursor-pointer ${
                        isCardZh
                          ? "border-purple-300 bg-purple-100 text-purple-700 dark:bg-purple-900/70 dark:border-purple-600 dark:text-purple-200"
                          : "border-slate-200 dark:border-slate-800 text-slate-400 hover:text-purple-600 hover:bg-purple-50 dark:hover:bg-slate-800"
                      }`}
                    >
                      <Languages className="h-3.5 w-3.5" />
                    </button>

                    {novel.rating !== undefined && novel.rating > 0 && (
                      <span
                        title={`Rating: ${novel.rating.toFixed(1)} / 5.0 (${novel.ratingCount || 1} votes)`}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-50 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300 text-[10px] font-bold border border-amber-200/70 dark:border-amber-900/40"
                      >
                        <Star className="h-3 w-3 fill-amber-400 text-amber-500" />
                        <span>{novel.rating.toFixed(1)} ★</span>
                        {novel.ratingCount ? <span className="text-[9px] opacity-75">({novel.ratingCount})</span> : null}
                      </span>
                    )}

                    {novel.aiquLikes !== undefined && novel.aiquLikes > 0 && novel.aiquLikes <= 10000 && (
                      <span
                        title={`Aiqu Site Votes: ${novel.aiquLikes.toLocaleString()}`}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 text-[10px] font-bold border border-emerald-200/70 dark:border-emerald-900/40"
                      >
                        <ThumbsUp className="h-3 w-3 fill-emerald-400/30 text-emerald-600" />
                        <span>{formatAiquVotes(novel.aiquLikes)}</span>
                      </span>
                    )}

                    {novel.siteId !== "dmxs" && novel.likes !== undefined && novel.likes > 0 && (
                      <span
                        title={`Summary Likes: ${formatLikes(novel.likes)}`}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-rose-50 dark:bg-rose-950/50 text-rose-700 dark:text-rose-300 text-[10px] font-bold border border-rose-200/70 dark:border-rose-900/40"
                      >
                        <Heart className="h-3 w-3 fill-rose-400 text-rose-500" />
                        <span>{formatLikes(novel.likes)}</span>
                      </span>
                    )}

                    {novel.points !== undefined && novel.points > 0 && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-50 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300 text-[10px] font-bold border border-amber-200/70 dark:border-amber-900/40">
                        <Star className="h-3 w-3 fill-amber-400 text-amber-500" />
                        <span>{formatPoints(novel.points)}</span>
                      </span>
                    )}
                  </div>
                </div>

                {/* Title & Author */}
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="flex flex-col gap-0.5">
                    <h4 className="font-bold text-slate-900 dark:text-slate-100 text-sm sm:text-base group-hover:text-purple-600 dark:group-hover:text-purple-400 transition leading-snug">
                      {renderHighlightedText(cardTitle, query)}
                    </h4>
                    <p className="text-[11px] sm:text-xs text-slate-500 dark:text-slate-400">
                      Author:{" "}
                      <span className="font-semibold text-slate-700 dark:text-slate-200">
                        {renderHighlightedText(cardAuthor, query)}
                      </span>
                    </p>
                  </div>

                  {novel.coverUrl && (
                    <img
                      src={novel.coverUrl}
                      alt={cardTitle}
                      className="h-16 w-12 rounded-lg object-cover border border-slate-200 dark:border-slate-800 shrink-0"
                    />
                  )}
                </div>

                {/* Synopsis / Intro with Dropdown Toggle */}
                {displayIntro && (
                  <div className="rounded-lg bg-slate-50/90 dark:bg-slate-800/40 border border-slate-200/80 dark:border-slate-800 p-2.5 sm:p-3 mb-2.5 text-[11px] sm:text-xs leading-relaxed text-slate-700 dark:text-slate-300">
                    <div className="flex items-center justify-between font-bold text-[10px] sm:text-[11px] text-purple-700 dark:text-purple-300 mb-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <BookOpen className="h-3.5 w-3.5 text-purple-600 dark:text-purple-400 shrink-0" />
                        <span>{isCardZh ? "Synopsis / 简介 (中文):" : "Synopsis (English):"}</span>
                        {isLoadingThisIntro && (
                          <span className="inline-flex items-center gap-1 text-[10px] font-normal text-purple-600 dark:text-purple-400 animate-pulse ml-1">
                            <Loader2 className="w-2.5 h-2.5 animate-spin" />
                            Loading full text...
                          </span>
                        )}
                      </div>

                      {isLongIntro && (
                        <button
                          type="button"
                          onClick={() => toggleSummary(novel)}
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold text-purple-600 dark:text-purple-400 hover:bg-purple-100 dark:hover:bg-purple-950/60 transition cursor-pointer"
                        >
                          {isExpanded ? (
                            <>
                              <span>Show Less</span>
                              <ChevronUp className="h-3 w-3" />
                            </>
                          ) : (
                            <>
                              <span>Read More</span>
                              <ChevronDown className="h-3 w-3" />
                            </>
                          )}
                        </button>
                      )}
                    </div>

                    <div className="whitespace-pre-line text-slate-600 dark:text-slate-300">
                      {isExpanded || !isLongIntro
                        ? renderHighlightedText(displayIntro, query)
                        : renderHighlightedText(
                            displayIntro.slice(0, 110) + (displayIntro.length > 110 ? "..." : ""),
                            query
                          )}
                    </div>
                  </div>
                )}

                {/* File Size / TXT Download info below summary */}
                <div className="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400 -mt-1 mb-2 px-0.5">
                  <span className="font-semibold text-slate-600 dark:text-slate-300">TXT File Size:</span>
                  <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 text-[10px] font-bold border border-emerald-200/70 dark:border-emerald-800/50">
                    💾 {novel.fileSize || "1.90 MB"}
                  </span>
                </div>

                {/* Action Controls */}
                <div className="mt-auto pt-2.5 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between gap-2">
                  <a
                    href={novel.novelUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[10px] sm:text-[11px] text-slate-400 hover:text-purple-500 flex items-center gap-1 transition"
                  >
                    <span>Source Webpage</span>
                    <ExternalLink className="h-3 w-3" />
                  </a>

                  {onOpenReader && (
                    <button
                      type="button"
                      onClick={() =>
                        onOpenReader({
                          novelTitle: cardTitle,
                          author: cardAuthor,
                          coverUrl: novel.coverUrl,
                          novelUrl: novel.novelUrl,
                          siteId: novel.siteId,
                          chapterIndex: 1,
                          totalChapters: novel.chapterCount || 0,
                        })
                      }
                      className="inline-flex items-center gap-1.5 rounded-lg border border-purple-200 dark:border-purple-800 bg-purple-50/70 dark:bg-purple-950/40 text-xs font-bold text-purple-700 dark:text-purple-300 hover:bg-purple-100 dark:hover:bg-purple-900/60 px-3 py-1.5 transition cursor-pointer shadow-2xs"
                    >
                      <BookOpen className="h-3.5 w-3.5" />
                      <span>Read</span>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => handleSelectNovel(novel)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-purple-600 hover:bg-purple-700 active:scale-95 text-white px-3 py-1.5 text-xs font-bold shadow-xs hover:shadow-purple-500/20 transition cursor-pointer"
                  >
                    <Download className="h-3.5 w-3.5" />
                    <span>Select & Import</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Novel Detail & Chapter Range Modal */}
      {(selectedNovel || isLoadingDetail) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in">
          <div className="w-full max-w-xl rounded-3xl border border-purple-100 dark:border-purple-900 bg-white dark:bg-slate-900 p-6 shadow-2xl flex flex-col gap-4 max-h-[92vh] overflow-y-auto">
            {isLoadingDetail ? (
              <div className="flex flex-col items-center justify-center py-12 gap-3">
                <Loader2 className="h-8 w-8 animate-spin text-purple-600" />
                <p className="text-xs font-medium text-slate-500">Fetching novel Table of Contents...</p>
              </div>
            ) : selectedNovel ? (
              <>
                {/* Header */}
                <div className="flex items-start justify-between gap-3 border-b border-slate-100 dark:border-slate-800 pb-3">
                  <div className="flex items-start gap-3 min-w-0">
                    {selectedNovel.coverUrl ? (
                      <img
                        src={selectedNovel.coverUrl}
                        alt={selectedNovel.title}
                        className="w-12 h-16 object-cover rounded-xl border border-black/10 shrink-0 shadow-xs"
                      />
                    ) : null}
                    <div className="min-w-0">
                      <span className="text-[10px] font-bold text-purple-600 dark:text-purple-400 uppercase tracking-wider">
                        {selectedNovel.siteName || "Novel Store"}
                      </span>
                      <h3 className="text-base sm:text-lg font-bold text-slate-900 dark:text-slate-100 line-clamp-2">
                        {selectedNovel.title}
                      </h3>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        Author: {selectedNovel.author || "Unknown"}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      if (!isScraping) setSelectedNovel(null);
                    }}
                    disabled={isScraping}
                    className="rounded-full p-1.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition shrink-0 cursor-pointer disabled:opacity-40"
                    title="Close"
                  >
                    <X className="h-5 w-5" />
                  </button>
                </div>

                {/* Synopsis */}
                {selectedNovel.intro && (
                  <div className="rounded-2xl bg-purple-50/50 dark:bg-slate-800/50 p-3 text-xs text-slate-600 dark:text-slate-300 leading-relaxed max-h-36 overflow-y-auto whitespace-pre-line border border-purple-100/50 dark:border-purple-900/30">
                    {selectedNovel.intro}
                  </div>
                )}

                {/* Chapter Range Selection */}
                <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 dark:border-slate-800 p-4 bg-slate-50/50 dark:bg-slate-950/50">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-800 dark:text-slate-200">
                      Select Chapter Range to Import:
                    </span>
                    <span className="text-xs font-semibold text-purple-600 dark:text-purple-400">
                      Total Chapters: {selectedNovel.chapters.length || "100+"}
                    </span>
                  </div>

                  {/* Quick Preset Buttons */}
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                    <span className="text-slate-400 font-medium mr-1">Presets:</span>
                    <button
                      type="button"
                      disabled={isScraping}
                      onClick={() => {
                        setStartChapter(1);
                        setEndChapter(Math.min(20, selectedNovel.chapters.length || 20));
                      }}
                      className="px-2.5 py-1 rounded-lg border border-purple-200 dark:border-purple-800/80 bg-white dark:bg-slate-900 hover:bg-purple-50 dark:hover:bg-purple-950/50 font-bold text-purple-700 dark:text-purple-300 transition cursor-pointer text-xs"
                    >
                      First 20 Ch
                    </button>
                    <button
                      type="button"
                      disabled={isScraping}
                      onClick={() => {
                        setStartChapter(1);
                        setEndChapter(Math.min(50, selectedNovel.chapters.length || 50));
                      }}
                      className="px-2.5 py-1 rounded-lg border border-purple-200 dark:border-purple-800/80 bg-white dark:bg-slate-900 hover:bg-purple-50 dark:hover:bg-purple-950/50 font-bold text-purple-700 dark:text-purple-300 transition cursor-pointer text-xs"
                    >
                      First 50 Ch
                    </button>
                    <button
                      type="button"
                      disabled={isScraping}
                      onClick={() => {
                        setStartChapter(1);
                        setEndChapter(Math.min(100, selectedNovel.chapters.length || 100));
                      }}
                      className="px-2.5 py-1 rounded-lg border border-purple-200 dark:border-purple-800/80 bg-white dark:bg-slate-900 hover:bg-purple-50 dark:hover:bg-purple-950/50 font-bold text-purple-700 dark:text-purple-300 transition cursor-pointer text-xs"
                    >
                      First 100 Ch
                    </button>
                    {selectedNovel.chapters.length > 0 && (
                      <button
                        type="button"
                        disabled={isScraping}
                        onClick={() => {
                          setStartChapter(1);
                          setEndChapter(selectedNovel.chapters.length);
                        }}
                        className="px-2.5 py-1 rounded-lg border border-purple-200 dark:border-purple-800/80 bg-white dark:bg-slate-900 hover:bg-purple-50 dark:hover:bg-purple-950/50 font-bold text-purple-700 dark:text-purple-300 transition cursor-pointer text-xs"
                      >
                        All ({selectedNovel.chapters.length} Ch)
                      </button>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-3 pt-1">
                    <div>
                      <label className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
                        Start Chapter
                      </label>
                      <input
                        type="number"
                        min={1}
                        max={selectedNovel.chapters.length || 1000}
                        value={startChapter}
                        disabled={isScraping}
                        onChange={(e) => setStartChapter(Math.max(1, parseInt(e.target.value) || 1))}
                        className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs text-slate-900 dark:text-slate-100 disabled:opacity-60"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
                        End Chapter
                      </label>
                      <input
                        type="number"
                        min={startChapter}
                        max={selectedNovel.chapters.length || 1000}
                        value={endChapter}
                        disabled={isScraping}
                        onChange={(e) =>
                          setEndChapter(
                            Math.max(startChapter, parseInt(e.target.value) || startChapter)
                          )
                        }
                        className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs text-slate-900 dark:text-slate-100 disabled:opacity-60"
                      />
                    </div>
                  </div>

                  <div className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center justify-between">
                    <span>
                      Will download chapters {startChapter} through {endChapter} (
                      {Math.max(0, endChapter - startChapter + 1)} chapters)
                    </span>
                  </div>
                </div>

                {/* Active Scraping Progress Card with Live Timer */}
                {isScraping && (
                  <div className="rounded-2xl border border-purple-200 dark:border-purple-800 bg-purple-50/70 dark:bg-purple-950/40 p-3.5 space-y-2 animate-in fade-in">
                    <div className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2 font-bold text-purple-700 dark:text-purple-300">
                        <Loader2 className="h-4 w-4 animate-spin text-purple-600 shrink-0" />
                        <span>Fetching chapters ({startChapter}–{endChapter})...</span>
                      </div>
                      <span className="font-mono text-[11px] font-semibold text-purple-700 dark:text-purple-300 bg-purple-100 dark:bg-purple-900/60 px-2 py-0.5 rounded-full">
                        {scrapeElapsedSec}s elapsed • working normally
                      </span>
                    </div>
                    <div className="w-full bg-purple-100 dark:bg-purple-900/50 h-1.5 rounded-full overflow-hidden">
                      <div className="h-full bg-gradient-to-r from-purple-500 via-indigo-500 to-pink-500 animate-pulse rounded-full w-full" />
                    </div>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-tight">
                      Compiling raw Chinese text from remote source into your translation workspace. This usually takes 3–15 seconds depending on chapter count.
                    </p>
                  </div>
                )}

                {/* Import Action Buttons - Stacked Cleanly so no button is cut off */}
                <div className="flex flex-col gap-2.5 pt-2 border-t border-slate-100 dark:border-slate-800">
                  {/* Primary 1-Click Action */}
                  <button
                    type="button"
                    onClick={() => handleStartImport(true)}
                    disabled={isScraping}
                    className="w-full flex items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-purple-600 via-indigo-600 to-purple-700 hover:from-purple-700 hover:to-indigo-800 px-5 py-3 text-sm font-extrabold text-white shadow-md hover:shadow-purple-500/25 active:scale-98 transition cursor-pointer disabled:opacity-60"
                  >
                    {isScraping ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>Compiling & Starting Instant Translation ({scrapeElapsedSec}s)...</span>
                      </>
                    ) : (
                      <>
                        <Sparkles className="h-4 w-4 text-amber-300" />
                        <span>⚡ Translate Now (1-Click Instant Start)</span>
                      </>
                    )}
                  </button>

                  {/* Secondary Actions Row */}
                  <div className="flex flex-wrap sm:flex-nowrap items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => setSelectedNovel(null)}
                      disabled={isScraping}
                      className="px-4 py-2 text-xs font-semibold text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl transition cursor-pointer disabled:opacity-50"
                    >
                      Cancel
                    </button>

                    <div className="flex items-center gap-2">
                      {onOpenReader && (
                        <button
                          type="button"
                          disabled={isScraping}
                          onClick={() => {
                            onOpenReader({
                              novelTitle: selectedNovel.title,
                              author: selectedNovel.author,
                              coverUrl: selectedNovel.coverUrl,
                              novelUrl: selectedNovel.novelUrl,
                              siteId: selectedNovel.siteId,
                              chapterIndex: startChapter,
                              totalChapters: selectedNovel.chapters.length,
                              allChapters: selectedNovel.chapters.map((c, i) => ({
                                title: c.title,
                                url: c.url,
                                index: i + 1,
                              })),
                            });
                            setSelectedNovel(null);
                          }}
                          className="inline-flex items-center gap-1.5 rounded-xl border border-purple-200 dark:border-purple-800 bg-purple-50/70 dark:bg-purple-950/40 px-3.5 py-2 text-xs font-bold text-purple-700 dark:text-purple-300 hover:bg-purple-100 dark:hover:bg-purple-900/60 transition cursor-pointer disabled:opacity-50 shadow-2xs"
                        >
                          <BookOpen className="h-3.5 w-3.5" />
                          <span>Read in Reader</span>
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => handleStartImport(false)}
                        disabled={isScraping}
                        className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700/60 px-3.5 py-2 text-xs font-bold text-slate-700 dark:text-slate-200 transition cursor-pointer disabled:opacity-50 shadow-2xs"
                      >
                        <Download className="h-3.5 w-3.5" />
                        <span>Import Raw Text</span>
                      </button>
                    </div>
                  </div>
                </div>
              </>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
};
