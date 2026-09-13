export type TranslationStyle =
  | "fluent"
  | "xianxia"
  | "literary"
  | "formal"
  | "literal";

export type TranslationMode = "cloud" | "browser";

export interface GlossaryTerm {
  id: string;
  original: string;
  translation: string;
  category?: string;
  notes?: string;
}

export type ChunkStatus = "pending" | "processing" | "completed" | "error";

export interface TextChunk {
  id: string;
  index: number;
  chapterTitle?: string;
  chineseText: string;
  englishText: string;
  charCount: number;
  status: ChunkStatus;
  attempts?: number;
  errorMessage?: string;
  durationMs?: number;
  edited?: boolean;
}

export interface TranslationSession {
  fileName: string;
  fileSizeBytes: number;
  totalChineseChars: number;
  chunks: TextChunk[];
  style: TranslationStyle;
  customInstructions: string;
  glossary: GlossaryTerm[];
  mode?: TranslationMode;
  status?: "idle" | "running" | "paused" | "completed";
  createdAt: number;
  lastUpdated: number;
  lastDownloadedWordCount?: number;
  lastDownloadedAt?: number;
}

export interface TranslationMetrics {
  totalChars: number;
  completedChars: number;
  totalChunks: number;
  completedChunks: number;
  inProgressChunks: number;
  errorChunks: number;
  completedEnglishWords: number;
  lastDownloadedWordCount: number;
  newWordsSinceLastDownload: number;
  startTime: number | null;
  elapsedMs: number;
  charsPerSecond: number;
  estimatedRemainingSeconds: number;
}

export interface AuthStatus {
  authenticated: boolean;
  requiresGoogle?: boolean;
  requiresPasscode: boolean;
  googleVerified?: boolean;
  passcodeVerified: boolean;
  userEmail?: string | null;
  authorizedEmail?: string;
  hasPasscodeConfigured: boolean;
}
