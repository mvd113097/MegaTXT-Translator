import React, { useState } from "react";
import {
  X,
  Plus,
  Trash2,
  Sparkles,
  BookOpen,
  Search,
  Check,
  AlertCircle,
  Download,
  Upload,
} from "lucide-react";
import { GlossaryTerm } from "../types";
import { SAMPLE_GLOSSARY } from "../data/sampleNovel";

interface GlossaryModalProps {
  isOpen: boolean;
  onClose: () => void;
  glossary: GlossaryTerm[];
  onSaveGlossary: (terms: GlossaryTerm[]) => void;
  sampleChineseText?: string;
}

export const GlossaryModal: React.FC<GlossaryModalProps> = ({
  isOpen,
  onClose,
  glossary,
  onSaveGlossary,
  sampleChineseText = "",
}) => {
  const [terms, setTerms] = useState<GlossaryTerm[]>(glossary);
  const [searchTerm, setSearchTerm] = useState("");
  const [newOriginal, setNewOriginal] = useState("");
  const [newTranslation, setNewTranslation] = useState("");
  const [newCategory, setNewCategory] = useState("Character");
  const [newNotes, setNewNotes] = useState("");
  const [isScanning, setIsScanning] = useState(false);
  const [scanStatus, setScanStatus] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleAddTerm = () => {
    if (!newOriginal.trim() || !newTranslation.trim()) return;
    const newTerm: GlossaryTerm = {
      id: `term-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      original: newOriginal.trim(),
      translation: newTranslation.trim(),
      category: newCategory,
      notes: newNotes.trim(),
    };
    const updated = [newTerm, ...terms];
    setTerms(updated);
    onSaveGlossary(updated);
    setNewOriginal("");
    setNewTranslation("");
    setNewNotes("");
  };

  const handleDeleteTerm = (id: string) => {
    const updated = terms.filter((t) => t.id !== id);
    setTerms(updated);
    onSaveGlossary(updated);
  };

  const handleLoadSamplePreset = () => {
    // Merge sample glossary avoiding duplicates
    const existing = new Set(terms.map((t) => t.original));
    const merged = [...terms];
    for (const item of SAMPLE_GLOSSARY) {
      if (!existing.has(item.original)) {
        merged.push({
          id: `term-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          original: item.original,
          translation: item.translation,
          category: item.category,
          notes: item.notes,
        });
      }
    }
    setTerms(merged);
    onSaveGlossary(merged);
  };

  const handleAutoScanWithAI = async () => {
    if (!sampleChineseText.trim()) {
      setScanStatus("Please load a text file first before scanning with AI.");
      return;
    }
    setIsScanning(true);
    setScanStatus("AI is scanning the first 12,000 characters for key names & terms...");

    try {
      const res = await fetch("/api/extract-glossary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: sampleChineseText }),
      });
      const data = await res.json();

      if (data.success && Array.isArray(data.terms)) {
        const existing = new Set(terms.map((t) => t.original));
        const newExtracted: GlossaryTerm[] = [];
        for (const item of data.terms) {
          if (item.original && item.translation && !existing.has(item.original)) {
            newExtracted.push({
              id: `term-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              original: item.original,
              translation: item.translation,
              category: item.category || "Character",
              notes: item.notes || "Auto-extracted by Gemini",
            });
          }
        }
        const updated = [...newExtracted, ...terms];
        setTerms(updated);
        onSaveGlossary(updated);
        setScanStatus(`Extracted ${newExtracted.length} new terminology rules!`);
      } else {
        setScanStatus(data.error || "Could not extract terms.");
      }
    } catch (err: any) {
      setScanStatus(err.message || "Failed to call glossary extraction.");
    } finally {
      setIsScanning(false);
    }
  };

  const filteredTerms = terms.filter(
    (t) =>
      t.original.toLowerCase().includes(searchTerm.toLowerCase()) ||
      t.translation.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (t.category && t.category.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 dark:bg-black/70 p-4 backdrop-blur-xs">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xl transition-colors duration-200">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 px-6 py-4">
          <div className="flex items-center gap-2">
            <BookOpen className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
            <div>
              <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">
                Terminology & Name Glossary ({terms.length})
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Enforce consistent character names, locations, and cultivation realms across all chunks
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-600 dark:hover:text-slate-200"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Action bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/60 px-6 py-3">
          <div className="flex items-center gap-2">
            <button
              id="ai-scan-terms-btn"
              onClick={handleAutoScanWithAI}
              disabled={isScanning}
              className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-xs transition hover:bg-indigo-700 disabled:opacity-50"
            >
              <Sparkles className="h-3.5 w-3.5" />
              <span>{isScanning ? "Scanning Text..." : "AI Auto-Scan Text for Names"}</span>
            </button>
            <button
              onClick={handleLoadSamplePreset}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 transition hover:bg-slate-50 dark:hover:bg-slate-700"
            >
              Load Novel Preset
            </button>
          </div>

          <div className="relative w-48 sm:w-60">
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400 dark:text-slate-500" />
            <input
              type="text"
              placeholder="Search glossary..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 py-1.5 pl-8 pr-3 text-xs text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
            />
          </div>
        </div>

        {scanStatus && (
          <div className="border-b border-slate-100 dark:border-slate-800 bg-indigo-50/50 dark:bg-indigo-950/40 px-6 py-2 text-xs text-indigo-800 dark:text-indigo-300">
            {scanStatus}
          </div>
        )}

        {/* Add new term row */}
        <div className="border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <div className="text-xs font-bold text-slate-700 dark:text-slate-200">Add Term Rule:</div>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-12">
            <input
              type="text"
              placeholder="Chinese (e.g. 萧炎)"
              value={newOriginal}
              onChange={(e) => setNewOriginal(e.target.value)}
              className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-2.5 py-1.5 text-xs text-slate-800 dark:text-slate-200 focus:border-indigo-500 focus:outline-none sm:col-span-3"
            />
            <input
              type="text"
              placeholder="English (e.g. Xiao Yan)"
              value={newTranslation}
              onChange={(e) => setNewTranslation(e.target.value)}
              className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-2.5 py-1.5 text-xs text-slate-800 dark:text-slate-200 focus:border-indigo-500 focus:outline-none sm:col-span-3"
            />
            <select
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
              className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-2 py-1.5 text-xs text-slate-700 dark:text-slate-200 sm:col-span-2"
            >
              <option value="Character">Character</option>
              <option value="Location">Location</option>
              <option value="Faction">Faction / Sect</option>
              <option value="Realm/Rank">Realm / Rank</option>
              <option value="Concept">Concept / Item</option>
            </select>
            <input
              type="text"
              placeholder="Notes (optional)"
              value={newNotes}
              onChange={(e) => setNewNotes(e.target.value)}
              className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-2.5 py-1.5 text-xs text-slate-800 dark:text-slate-200 focus:border-indigo-500 focus:outline-none sm:col-span-3"
            />
            <button
              onClick={handleAddTerm}
              className="inline-flex items-center justify-center rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-700 sm:col-span-1"
              title="Add term"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Terms list */}
        <div className="flex-1 overflow-y-auto p-4">
          {filteredTerms.length === 0 ? (
            <div className="py-8 text-center text-xs text-slate-400 dark:text-slate-500">
              No glossary terms found. Click "AI Auto-Scan" or add one above.
            </div>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {filteredTerms.map((term) => (
                <div
                  key={term.id}
                  className="flex items-center justify-between py-2 text-xs transition hover:bg-slate-50 dark:hover:bg-slate-800/50"
                >
                  <div className="flex items-center gap-3">
                    <span className="font-semibold text-slate-900 dark:text-slate-100">{term.original}</span>
                    <span className="text-slate-400">→</span>
                    <span className="font-medium text-indigo-600 dark:text-indigo-400">{term.translation}</span>
                    {term.category && (
                      <span className="rounded-sm bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-600 dark:text-slate-300">
                        {term.category}
                      </span>
                    )}
                    {term.notes && (
                      <span className="text-[11px] text-slate-400 dark:text-slate-500 italic">({term.notes})</span>
                    )}
                  </div>
                  <button
                    onClick={() => handleDeleteTerm(term.id)}
                    className="p-1 text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 transition"
                    title="Delete term"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end border-t border-slate-200 dark:border-slate-800 px-6 py-3">
          <button
            onClick={onClose}
            className="rounded-lg bg-indigo-600 px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-700 active:scale-95"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
