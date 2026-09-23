import React, { useState, useEffect, useMemo } from "react";
import {
  BookOpen,
  Library,
  Trash2,
  ExternalLink,
  Sparkles,
  Download,
  Search,
  BookMarked,
  Clock,
  ArrowRight,
  TrendingUp,
  Zap,
  Cloud,
} from "lucide-react";
import { LibraryBook } from "../types";
import {
  getLocalLibraryBooks,
  removeBookFromLibrary,
  getAllNovelCachedChapterCounts,
} from "../utils/indexedDbStorage";

interface LibraryViewProps {
  onOpenReader: (novel: {
    novelTitle: string;
    author?: string;
    coverUrl?: string;
    novelUrl?: string;
    siteId?: string;
    chapterIndex?: number;
    totalChapters?: number;
  }) => void;
  onSearchStore?: (keyword: string, site?: string) => void;
  onTranslateWholeBook?: (book: LibraryBook) => void;
}

export const LibraryView: React.FC<LibraryViewProps> = ({
  onOpenReader,
  onSearchStore,
  onTranslateWholeBook,
}) => {
  const [books, setBooks] = useState<LibraryBook[]>(() => getLocalLibraryBooks());
  const [searchQuery, setSearchQuery] = useState("");
  const [cacheCounts, setCacheCounts] = useState<Record<string, number>>({});

  const refreshBooks = () => {
    setBooks(getLocalLibraryBooks());
    getAllNovelCachedChapterCounts().then(setCacheCounts).catch(() => {});
  };

  useEffect(() => {
    refreshBooks();
    const handleStorage = (e: StorageEvent) => {
      if (e.key === "megatext_user_library_v1") {
        refreshBooks();
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const handleRemove = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const updated = removeBookFromLibrary(id);
    setBooks(updated);
  };

  const filteredBooks = useMemo(() => {
    if (!searchQuery.trim()) return books;
    const q = searchQuery.toLowerCase();
    return books.filter(
      (b) =>
        b.title.toLowerCase().includes(q) ||
        (b.author && b.author.toLowerCase().includes(q)) ||
        (b.summary && b.summary.toLowerCase().includes(q))
    );
  }, [books, searchQuery]);

  return (
    <div className="w-full space-y-4 animate-in fade-in duration-200">
      {/* Top Header Card */}
      <div className="relative overflow-hidden rounded-3xl border border-purple-200/80 dark:border-purple-900/40 bg-gradient-to-br from-purple-900 via-indigo-950 to-slate-950 p-5 sm:p-6 text-white shadow-xl">
        <div className="relative z-10 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="inline-flex items-center gap-2 rounded-full bg-purple-500/20 px-3 py-1 text-xs font-bold text-purple-200 backdrop-blur-md border border-purple-400/30">
              <Library className="h-3.5 w-3.5" />
              <span>Personal Reading Bookshelf</span>
            </div>
            <h2 className="text-xl sm:text-2xl font-black tracking-tight text-white">
              My Library
            </h2>
            <p className="text-xs sm:text-sm text-purple-200/80 max-w-md">
              Your saved web novels, reading progress bars, and offline chapter history.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <div className="px-4 py-2 rounded-2xl bg-white/10 backdrop-blur-md border border-white/10 text-center">
              <span className="text-lg sm:text-xl font-black text-white block leading-tight">
                {books.length}
              </span>
              <span className="text-[10px] uppercase font-bold text-purple-200/70 tracking-wider">
                Novels Saved
              </span>
            </div>
          </div>
        </div>

        {/* Decorative background glow */}
        <div className="absolute -bottom-10 -right-10 w-48 h-48 rounded-full bg-purple-600/20 blur-3xl pointer-events-none" />
      </div>

      {/* Filter / Search Bar */}
      {books.length > 0 && (
        <div className="relative">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search saved books by title or author..."
            className="w-full pl-10 pr-4 py-2.5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-xs sm:text-sm text-slate-800 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-purple-500/50 transition shadow-xs"
          />
        </div>
      )}

      {/* Empty State */}
      {books.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-purple-200 dark:border-purple-900/60 bg-white/60 dark:bg-slate-900/50 p-10 text-center space-y-4 shadow-sm backdrop-blur-xs">
          <div className="mx-auto w-14 h-14 rounded-2xl bg-purple-100 dark:bg-purple-950/60 text-purple-600 dark:text-purple-400 flex items-center justify-center shadow-inner">
            <BookMarked className="h-7 w-7" />
          </div>
          <div className="max-w-sm mx-auto space-y-1.5">
            <h3 className="text-base font-bold text-slate-800 dark:text-slate-200">
              Your Library is Empty
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
              When exploring novels, press <strong>Read</strong> and tap <strong>Add to Library</strong> in the reader to track your reading progress and translate books.
            </p>
          </div>
        </div>
      ) : filteredBooks.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 text-center text-slate-500 text-xs">
          No books found matching "{searchQuery}".
        </div>
      ) : (
        /* Bookshelf Grid */
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 sm:gap-4">
          {filteredBooks.map((book) => {
            const currentCh = book.currentChapterIndex || 1;
            const totalCh = book.totalChapters || 1;
            const progressPercent = Math.min(100, Math.round((currentCh / Math.max(1, totalCh)) * 100));
            const novelKey = book.id || `${book.siteId || "src"}_${book.title}`.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5]/g, "_");
            const cachedChCount = cacheCounts[book.id] || cacheCounts[novelKey] || Object.entries(cacheCounts).find(([k]) => k.includes(book.title))?.[1] || 0;

            return (
              <div
                key={book.id}
                onClick={() => {
                  onOpenReader({
                    novelTitle: book.title,
                    author: book.author,
                    coverUrl: book.coverUrl,
                    novelUrl: book.novelUrl,
                    siteId: book.siteId,
                    chapterIndex: book.currentChapterIndex || 1,
                    totalChapters: book.totalChapters || 1,
                  });
                }}
                className="group relative rounded-2xl border border-purple-100/80 dark:border-slate-800/80 bg-white dark:bg-slate-900 p-4 shadow-xs hover:shadow-md hover:border-purple-300 dark:hover:border-purple-700/60 transition-all cursor-pointer flex flex-col justify-between gap-3"
              >
                {/* Book Details Header */}
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap mb-1">
                      {book.siteName && (
                        <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md bg-purple-100 dark:bg-purple-950/60 text-purple-700 dark:text-purple-300">
                          {book.siteName}
                        </span>
                      )}

                      {/* Offline Cached Badge */}
                      {cachedChCount > 0 ? (
                        <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-md bg-emerald-100 dark:bg-emerald-950/80 text-emerald-700 dark:text-emerald-300 border border-emerald-300/60 dark:border-emerald-800/60">
                          <Zap className="h-2.5 w-2.5 text-emerald-600 dark:text-emerald-400 fill-current" />
                          <span>{cachedChCount} Ch Offline Ready</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400">
                          <Cloud className="h-2.5 w-2.5" />
                          <span>Online Stream</span>
                        </span>
                      )}

                      <span className="text-[10px] text-slate-400 font-medium">
                        Added {new Date(book.addedAt || Date.now()).toLocaleDateString()}
                      </span>
                    </div>

                    <h3 className="text-sm sm:text-base font-bold text-slate-900 dark:text-white truncate group-hover:text-purple-600 dark:group-hover:text-purple-400 transition-colors">
                      {book.title}
                    </h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400 truncate mt-0.5">
                      {book.author ? (
                        <span className="inline-flex items-center gap-1">
                          <span>Author:</span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (onSearchStore && book.author) {
                                const cleanAuthor = book.author.replace(/^作者[：:]\s*/i, "").replace(/^by\s*[:：]?\s*/i, "").trim();
                                if (cleanAuthor) onSearchStore(cleanAuthor, "aiqu226");
                              }
                            }}
                            title={`Search all novels by "${book.author}" in Store`}
                            className="font-semibold text-purple-700 dark:text-purple-300 hover:text-purple-900 dark:hover:text-purple-100 hover:underline inline-flex items-center gap-1 cursor-pointer transition"
                          >
                            <span>{book.author}</span>
                            <Search className="w-2.5 h-2.5 opacity-60" />
                          </button>
                        </span>
                      ) : (
                        "Web Novel"
                      )}
                    </p>
                  </div>

                  {/* Delete from library button */}
                  <button
                    type="button"
                    onClick={(e) => handleRemove(book.id, e)}
                    title="Remove from Library"
                    className="p-1.5 rounded-xl text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition cursor-pointer shrink-0"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>

                {/* Reading Progress Section */}
                <div className="space-y-1.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 p-2.5 border border-slate-100 dark:border-slate-800">
                  <div className="flex items-center justify-between text-xs font-semibold">
                    <span className="flex items-center gap-1 text-slate-600 dark:text-slate-300">
                      <TrendingUp className="h-3.5 w-3.5 text-purple-600" />
                      <span>Reading Progress</span>
                    </span>
                    <span className="text-purple-700 dark:text-purple-300 font-bold">
                      Ch {currentCh} / {totalCh} ({progressPercent}%)
                    </span>
                  </div>

                  {/* Progress Bar */}
                  <div className="h-2 w-full rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-purple-600 to-indigo-500 transition-all duration-300 rounded-full"
                      style={{ width: `${progressPercent}%` }}
                    />
                  </div>

                  {book.lastReadChapterTitle && (
                    <p className="text-[11px] text-slate-400 truncate pt-0.5">
                      Last read: {book.lastReadChapterTitle}
                    </p>
                  )}
                </div>

                {/* Action Buttons */}
                <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-slate-100 dark:border-slate-800/80">
                  <div className="flex items-center gap-1.5">
                    {/* Translate whole book button */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (onTranslateWholeBook) {
                          onTranslateWholeBook(book);
                        } else if (onSearchStore) {
                          onSearchStore(book.title);
                        }
                      }}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-purple-50 dark:bg-purple-950/40 border border-purple-200 dark:border-purple-800/60 text-purple-700 dark:text-purple-300 text-[11px] font-bold hover:bg-purple-100 dark:hover:bg-purple-900/60 transition cursor-pointer active:scale-95"
                      title="Translate entire book with AI translator"
                    >
                      <Sparkles className="h-3 w-3 text-purple-600" />
                      <span>Translate Whole Book</span>
                    </button>

                    {/* Search in Stores button */}
                    {onSearchStore && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onSearchStore(book.title);
                        }}
                        className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg text-slate-500 dark:text-slate-400 hover:text-purple-600 dark:hover:text-purple-300 text-[11px] font-medium transition cursor-pointer"
                        title="Search mirrors across 11 stores"
                      >
                        <Search className="h-3 w-3" />
                        <span>Stores</span>
                      </button>
                    )}
                  </div>

                  {/* Continue Reading Button */}
                  <button
                    type="button"
                    onClick={() => {
                      onOpenReader({
                        novelTitle: book.title,
                        author: book.author,
                        coverUrl: book.coverUrl,
                        novelUrl: book.novelUrl,
                        siteId: book.siteId,
                        chapterIndex: book.currentChapterIndex || 1,
                        totalChapters: book.totalChapters || 1,
                      });
                    }}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-700 text-white text-xs font-bold shadow-2xs transition cursor-pointer active:scale-95"
                  >
                    <BookOpen className="h-3.5 w-3.5" />
                    <span>Read</span>
                    <ArrowRight className="h-3 w-3" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
