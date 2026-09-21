import React, { useState, useEffect, useMemo } from "react";
import {
  X,
  Sparkles,
  Plus,
  Trash2,
  Edit2,
  Check,
  Search,
  BookMarked,
  Layers,
  Filter,
  Download,
  Loader2,
  AlertCircle,
  Tag,
  ShieldCheck,
  ArrowRight,
  RefreshCw,
} from "lucide-react";
import {
  NovelGlossaryTerm,
  getNovelGlossary,
  saveNovelGlossary,
  replaceTermsInNovelCache,
} from "../utils/indexedDbStorage";

interface NovelGlossaryDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  novelId: string;
  novelTitle: string;
  author?: string;
  chineseSampleText: string;
  getAuthHeaders?: () => Record<string, string>;
  onApplyToGlobalGlossary?: (terms: NovelGlossaryTerm[]) => void;
  onGlossaryChanged?: (terms: NovelGlossaryTerm[]) => void;
  onApplyReplacementsToReader?: (replacements: Array<{ from: string; to: string }>) => { updatedCount: number };
}

const CATEGORIES: Array<NovelGlossaryTerm["category"]> = [
  "Character",
  "Faction",
  "Realm/Skill",
  "Location",
  "Item",
  "General",
];

export const NovelGlossaryDrawer: React.FC<NovelGlossaryDrawerProps> = ({
  isOpen,
  onClose,
  novelId,
  novelTitle,
  author,
  chineseSampleText,
  getAuthHeaders,
  onApplyToGlobalGlossary,
  onGlossaryChanged,
  onApplyReplacementsToReader,
}) => {
  const [terms, setTerms] = useState<NovelGlossaryTerm[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [scanStatus, setScanStatus] = useState<string | null>(null);
  const [applyStatus, setApplyStatus] = useState<string | null>(null);
  const [isApplying, setIsApplying] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<string>("All");
  const [searchQuery, setSearchQuery] = useState("");

  // Add / Edit term state
  const [showAddForm, setShowAddForm] = useState(false);
  const [formMode, setFormMode] = useState<"chinese" | "english_swap">("chinese");
  const [editingTermId, setEditingTermId] = useState<string | null>(null);
  const [formOriginal, setFormOriginal] = useState("");
  const [formTranslation, setFormTranslation] = useState("");
  const [formCategory, setFormCategory] = useState<NovelGlossaryTerm["category"]>("Character");
  const [formNotes, setFormNotes] = useState("");

  // Load saved terms from IndexedDB on open
  useEffect(() => {
    if (!isOpen || !novelId) return;
    let mounted = true;
    setIsLoading(true);
    getNovelGlossary(novelId)
      .then((saved) => {
        if (mounted) {
          setTerms(saved);
          setIsLoading(false);
          onGlossaryChanged?.(saved);
        }
      })
      .catch(() => {
        if (mounted) setIsLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [isOpen, novelId]);

  // Auto-scan glossary
  const handleAutoScan = async () => {
    if (!chineseSampleText.trim()) {
      setScanStatus("No chapter text available to scan. Open or load a chapter first.");
      return;
    }

    setIsScanning(true);
    setScanStatus("Scanning Chinese text for characters, sects, realms & terms...");

    try {
      const res = await fetch("/api/novel-glossary/auto-scan", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(getAuthHeaders ? getAuthHeaders() : {}),
        },
        body: JSON.stringify({
          text: chineseSampleText.slice(0, 14000),
          novelTitle,
          author,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to scan glossary.");
      }

      if (data.terms && Array.isArray(data.terms)) {
        const existingMap = new Map<string, NovelGlossaryTerm>();
        terms.forEach((t) => existingMap.set(t.original, t));

        let newCount = 0;
        const newTerms: NovelGlossaryTerm[] = [];

        data.terms.forEach((item: any) => {
          if (!item.original || !item.translation) return;
          if (!existingMap.has(item.original)) {
            newCount++;
            newTerms.push({
              id: `term-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              original: item.original,
              translation: item.translation,
              category: item.category || "General",
              notes: item.notes,
            });
          }
        });

        const merged = [...newTerms, ...terms];
        setTerms(merged);
        await saveNovelGlossary(novelId, merged);
        onGlossaryChanged?.(merged);
        setScanStatus(`Discovered ${newCount} new terms! Saved to offline storage.`);
      } else {
        setScanStatus("No recurring terms detected in this sample.");
      }
    } catch (err: any) {
      setScanStatus(err.message || "Failed to auto-scan.");
    } finally {
      setIsScanning(false);
    }
  };

  // Add / Update term
  const handleSaveTerm = async () => {
    if (!formOriginal.trim() || !formTranslation.trim()) return;

    let next: NovelGlossaryTerm[];
    if (editingTermId) {
      next = terms.map((t) =>
        t.id === editingTermId
          ? {
              ...t,
              original: formOriginal.trim(),
              translation: formTranslation.trim(),
              category: formCategory,
              notes: formNotes.trim(),
            }
          : t
      );
    } else {
      const newTerm: NovelGlossaryTerm = {
        id: `term-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        original: formOriginal.trim(),
        translation: formTranslation.trim(),
        category: formCategory,
        notes: formNotes.trim() || (formMode === "english_swap" ? "English Name Swap" : ""),
      };
      next = [newTerm, ...terms];
    }

    setTerms(next);
    await saveNovelGlossary(novelId, next);
    onGlossaryChanged?.(next);

    // Apply all glossary rules to reader & offline cache immediately
    const allReplacements = next.map((t) => ({ from: t.original, to: t.translation }));
    if (onApplyReplacementsToReader) {
      onApplyReplacementsToReader(allReplacements);
    }
    replaceTermsInNovelCache(novelId, allReplacements);

    // Reset form
    setShowAddForm(false);
    setEditingTermId(null);
    setFormOriginal("");
    setFormTranslation("");
    setFormNotes("");
    setApplyStatus(`Saved rule: "${formOriginal.trim()}" → "${formTranslation.trim()}". Applied to reader!`);
  };

  // Delete term
  const handleDeleteTerm = async (id: string) => {
    const next = terms.filter((t) => t.id !== id);
    setTerms(next);
    await saveNovelGlossary(novelId, next);
    onGlossaryChanged?.(next);
  };

  // Manual trigger to replace all terms in reader & IndexedDB offline cache
  const handleApplyAllToReaderAndCache = async () => {
    if (terms.length === 0) return;
    setIsApplying(true);
    setApplyStatus(null);
    try {
      const replacements = terms.map((t) => ({ from: t.original, to: t.translation }));
      let inMemCount = 0;
      if (onApplyReplacementsToReader) {
        const res = onApplyReplacementsToReader(replacements);
        inMemCount = res?.updatedCount || 0;
      }
      const cacheRes = await replaceTermsInNovelCache(novelId, replacements);
      setApplyStatus(
        `Applied! Updated ${cacheRes.chaptersUpdated} cached chapters (${cacheRes.totalReplacements} names replaced) with 0 KB mobile data.`
      );
    } catch (err: any) {
      setApplyStatus(`Failed to apply replacements: ${err.message || err}`);
    } finally {
      setIsApplying(false);
    }
  };

  // Filtered terms
  const filteredTerms = useMemo(() => {
    return terms.filter((t) => {
      const matchesCat = selectedCategory === "All" || t.category === selectedCategory;
      if (!matchesCat) return false;
      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase();
      return (
        t.original.toLowerCase().includes(q) ||
        t.translation.toLowerCase().includes(q) ||
        (t.notes && t.notes.toLowerCase().includes(q))
      );
    });
  }, [terms, selectedCategory, searchQuery]);

  // Category counts
  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { All: terms.length };
    for (const c of CATEGORIES) counts[c] = 0;
    terms.forEach((t) => {
      if (counts[t.category] !== undefined) {
        counts[t.category]++;
      }
    });
    return counts;
  }, [terms]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-xs animate-in fade-in duration-150">
      <div className="w-full max-w-lg bg-white dark:bg-slate-900 h-full flex flex-col shadow-2xl border-l border-slate-200 dark:border-slate-800 text-slate-800 dark:text-slate-100">
        {/* Header */}
        <div className="p-4 sm:p-5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3 bg-slate-50/70 dark:bg-slate-900/90 shrink-0">
          <div className="min-w-0 flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-purple-600/15 text-purple-700 dark:text-purple-300">
              <BookMarked className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <h3 className="font-bold text-sm sm:text-base truncate leading-tight">Novel Glossary</h3>
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-purple-100 dark:bg-purple-950 text-purple-700 dark:text-purple-300">
                  {terms.length} terms
                </span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 truncate mt-0.5">
                {novelTitle}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="Close Glossary"
            className="p-2 rounded-xl text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Action Bar: Auto-Scan & Add */}
        <div className="p-3 sm:p-4 border-b border-slate-200 dark:border-slate-800 bg-purple-50/50 dark:bg-purple-950/20 flex flex-wrap items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              type="button"
              onClick={handleAutoScan}
              disabled={isScanning}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-purple-600 hover:bg-purple-700 text-white text-xs font-bold shadow-xs active:scale-95 transition cursor-pointer disabled:opacity-50"
            >
              {isScanning ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>Scanning...</span>
                </>
              ) : (
                <>
                  <Sparkles className="h-3.5 w-3.5" />
                  <span>Auto-Generate</span>
                </>
              )}
            </button>

            {/* Quick English Name Swap Button */}
            <button
              type="button"
              onClick={() => {
                setEditingTermId(null);
                setFormMode("english_swap");
                setFormOriginal("");
                setFormTranslation("");
                setFormCategory("Character");
                setFormNotes("English Name Swap");
                setShowAddForm(true);
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-purple-100 hover:bg-purple-200 dark:bg-purple-900/60 dark:hover:bg-purple-800 text-purple-800 dark:text-purple-200 text-xs font-bold transition cursor-pointer"
            >
              <ArrowRight className="h-3 w-3" />
              <span>Swap English Name</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setEditingTermId(null);
                setFormMode("chinese");
                setFormOriginal("");
                setFormTranslation("");
                setFormNotes("");
                setShowAddForm(!showAddForm);
              }}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border border-slate-200 dark:border-slate-700 hover:bg-white dark:hover:bg-slate-800 text-xs font-semibold text-slate-700 dark:text-slate-200 transition cursor-pointer"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Add Term</span>
            </button>
          </div>

          {terms.length > 0 && (
            <button
              type="button"
              onClick={handleApplyAllToReaderAndCache}
              disabled={isApplying}
              title="Apply all name replacements to current chapter and offline storage (0 KB data)"
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-950/60 dark:hover:bg-emerald-900 border border-emerald-300 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300 text-xs font-bold transition cursor-pointer"
            >
              {isApplying ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
              <span>Apply to Cache</span>
            </button>
          )}
        </div>

        {/* Scan / Apply Status Notice */}
        {(scanStatus || applyStatus) && (
          <div className="p-3 bg-purple-100/80 dark:bg-purple-950/70 border-b border-purple-200 dark:border-purple-800/50 text-purple-900 dark:text-purple-200 text-xs flex items-center justify-between gap-2 shrink-0">
            <span className="truncate">{applyStatus || scanStatus}</span>
            <button
              type="button"
              onClick={() => {
                setScanStatus(null);
                setApplyStatus(null);
              }}
              className="text-purple-700 dark:text-purple-400 hover:opacity-80 p-0.5 cursor-pointer"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Informative Tip Card on English Name Replacements */}
        <div className="px-4 py-2.5 bg-slate-50 dark:bg-slate-800/40 border-b border-slate-200 dark:border-slate-800 flex items-start gap-2 text-[11px] text-slate-600 dark:text-slate-400">
          <span className="text-purple-600 dark:text-purple-400 font-bold shrink-0">💡 Tip:</span>
          <div className="leading-snug">
            To change English character names (e.g. <span className="font-semibold text-purple-700 dark:text-purple-300">Lana → Lina</span> or <span className="font-semibold text-purple-700 dark:text-purple-300">Jake → Dylan</span>), click <strong className="text-slate-800 dark:text-slate-200">Swap English Name</strong> or edit any existing term. Replacements apply in real time!
          </div>
        </div>

        {/* Add / Edit Form Modal-let */}
        {showAddForm && (
          <div className="p-4 border-b border-purple-200 dark:border-purple-800 bg-purple-50/50 dark:bg-purple-950/40 space-y-3 shrink-0">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1 bg-slate-200 dark:bg-slate-800 p-0.5 rounded-lg text-xs">
                <button
                  type="button"
                  onClick={() => setFormMode("english_swap")}
                  className={`px-2 py-1 rounded-md font-bold transition cursor-pointer ${
                    formMode === "english_swap"
                      ? "bg-purple-600 text-white shadow-xs"
                      : "text-slate-600 dark:text-slate-400 hover:text-slate-900"
                  }`}
                >
                  English Name Swap (e.g. Lana → Lina)
                </button>
                <button
                  type="button"
                  onClick={() => setFormMode("chinese")}
                  className={`px-2 py-1 rounded-md font-bold transition cursor-pointer ${
                    formMode === "chinese"
                      ? "bg-purple-600 text-white shadow-xs"
                      : "text-slate-600 dark:text-slate-400 hover:text-slate-900"
                  }`}
                >
                  Chinese → English
                </button>
              </div>

              <button
                type="button"
                onClick={() => setShowAddForm(false)}
                className="text-slate-400 hover:text-slate-600 text-xs cursor-pointer"
              >
                Cancel
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] font-bold text-slate-500">
                  {formMode === "english_swap" ? "Current Name in Text (e.g. Lana / Jake)" : "Original (Chinese)"}
                </label>
                <input
                  type="text"
                  placeholder={formMode === "english_swap" ? "e.g. Lana or Jake" : "e.g. 萧炎"}
                  value={formOriginal}
                  onChange={(e) => setFormOriginal(e.target.value)}
                  className="w-full mt-0.5 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs focus:ring-1 focus:ring-purple-500"
                />
              </div>
              <div>
                <label className="text-[10px] font-bold text-slate-500">
                  {formMode === "english_swap" ? "Replace With (e.g. Lina / Dylan)" : "English Translation"}
                </label>
                <input
                  type="text"
                  placeholder={formMode === "english_swap" ? "e.g. Lina or Dylan" : "e.g. Xiao Yan"}
                  value={formTranslation}
                  onChange={(e) => setFormTranslation(e.target.value)}
                  className="w-full mt-0.5 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs focus:ring-1 focus:ring-purple-500"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] font-bold text-slate-500">Category</label>
                <select
                  value={formCategory}
                  onChange={(e) => setFormCategory(e.target.value as any)}
                  className="w-full mt-0.5 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs cursor-pointer"
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[10px] font-bold text-slate-500">Role / Context Note</label>
                <input
                  type="text"
                  placeholder={formMode === "english_swap" ? "e.g. Female protagonist name fix" : "e.g. Main protagonist"}
                  value={formNotes}
                  onChange={(e) => setFormNotes(e.target.value)}
                  className="w-full mt-0.5 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs"
                />
              </div>
            </div>

            <p className="text-[11px] text-purple-700 dark:text-purple-300">
              {formMode === "english_swap"
                ? `Rule: Every "${formOriginal || "Lana"}" will be replaced with "${formTranslation || "Lina"}" in the reader and offline cache.`
                : `Rule: "${formOriginal || "萧炎"}" will be translated as "${formTranslation || "Xiao Yan"}".`}
            </p>

            <button
              type="button"
              onClick={handleSaveTerm}
              className="w-full py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg text-xs font-bold transition cursor-pointer"
            >
              {editingTermId ? "Update Rule & Apply to Reader" : "Save Rule & Apply to Reader"}
            </button>
          </div>
        )}

        {/* Search & Category Filter Pills */}
        <div className="p-3 border-b border-slate-200 dark:border-slate-800 space-y-2 shrink-0">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
            <input
              type="text"
              placeholder="Search terms, English or Chinese..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs focus:outline-hidden focus:ring-1 focus:ring-purple-500"
            />
          </div>

          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 no-scrollbar text-xs">
            {["All", ...CATEGORIES].map((cat) => {
              const active = selectedCategory === cat;
              const count = categoryCounts[cat] || 0;
              return (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setSelectedCategory(cat)}
                  className={`px-2.5 py-1 rounded-lg font-medium whitespace-nowrap transition cursor-pointer flex items-center gap-1 ${
                    active
                      ? "bg-purple-600 text-white"
                      : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200"
                  }`}
                >
                  <span>{cat}</span>
                  <span
                    className={`text-[10px] px-1 rounded-full ${
                      active
                        ? "bg-purple-800 text-white"
                        : "bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-400"
                    }`}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Term List Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
          {isLoading ? (
            <div className="py-20 text-center text-slate-400 space-y-2">
              <Loader2 className="h-6 w-6 animate-spin mx-auto text-purple-600" />
              <p className="text-xs">Loading glossary terms...</p>
            </div>
          ) : filteredTerms.length === 0 ? (
            <div className="py-16 text-center space-y-3">
              <div className="p-3 w-12 h-12 mx-auto rounded-2xl bg-purple-50 dark:bg-purple-950/60 text-purple-600 dark:text-purple-300 flex items-center justify-center">
                <BookMarked className="h-6 w-6" />
              </div>
              <div>
                <p className="font-bold text-sm">No terms in this category</p>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-xs mx-auto">
                  Click &quot;Auto-Generate Glossary&quot; to scan character names, sects, and cultivation realms from this novel automatically.
                </p>
              </div>
            </div>
          ) : (
            filteredTerms.map((term) => (
              <div
                key={term.id}
                className="p-3 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-800/80 hover:border-purple-300 dark:hover:border-purple-700/60 transition shadow-2xs space-y-1.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    {/^[A-Za-z0-9\s'._-]+$/.test(term.original) ? (
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="font-semibold text-xs text-slate-500 line-through decoration-rose-400">
                          {term.original}
                        </span>
                        <ArrowRight className="h-3 w-3 text-purple-600 dark:text-purple-400 shrink-0" />
                        <span className="font-bold text-sm text-purple-700 dark:text-purple-300">
                          {term.translation}
                        </span>
                        <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-purple-100 dark:bg-purple-950 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-800">
                          Name Swap
                        </span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-sm text-slate-900 dark:text-slate-50">
                          {term.translation}
                        </span>
                        <span className="text-xs font-serif px-1.5 py-0.5 rounded-md bg-slate-100 dark:bg-slate-700/80 text-purple-700 dark:text-purple-300 font-medium">
                          {term.original}
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <span
                      className={`text-[9px] font-bold px-1.5 py-0.5 rounded-md ${
                        term.category === "Character"
                          ? "bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-300"
                          : term.category === "Faction"
                          ? "bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300"
                          : term.category === "Realm/Skill"
                          ? "bg-amber-100 dark:bg-amber-950 text-amber-700 dark:text-amber-300"
                          : term.category === "Location"
                          ? "bg-indigo-100 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300"
                          : term.category === "Item"
                          ? "bg-rose-100 dark:bg-rose-950 text-rose-700 dark:text-rose-300"
                          : "bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300"
                      }`}
                    >
                      {term.category}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingTermId(term.id);
                        setFormOriginal(term.original);
                        setFormTranslation(term.translation);
                        setFormCategory(term.category);
                        setFormNotes(term.notes || "");
                        setFormMode(/^[A-Za-z0-9\s'._-]+$/.test(term.original) ? "english_swap" : "chinese");
                        setShowAddForm(true);
                      }}
                      title="Edit Term"
                      className="p-1 rounded-lg text-slate-400 hover:text-purple-600 transition cursor-pointer"
                    >
                      <Edit2 className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteTerm(term.id)}
                      title="Delete Term"
                      className="p-1 rounded-lg text-slate-400 hover:text-rose-600 transition cursor-pointer"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                {term.notes && (
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                    {term.notes}
                  </p>
                )}
              </div>
            ))
          )}
        </div>

        {/* Footer info: 0 Mobile Data Guarantee & Sync */}
        <div className="p-3.5 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/90 flex items-center justify-between text-xs text-slate-500 shrink-0">
          <div className="flex items-center gap-1 text-[11px] text-emerald-700 dark:text-emerald-400">
            <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
            <span>Saved Offline (0 KB Data to browse)</span>
          </div>
          {onApplyToGlobalGlossary && terms.length > 0 && (
            <button
              type="button"
              onClick={() => onApplyToGlobalGlossary(terms)}
              className="px-2.5 py-1 rounded-lg bg-purple-600/10 hover:bg-purple-600/20 text-purple-700 dark:text-purple-300 text-[11px] font-bold transition cursor-pointer"
            >
              Sync to Translation Engine
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
