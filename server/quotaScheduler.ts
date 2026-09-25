import { GoogleGenAI } from "@google/genai";

export interface ProjectConfig {
  id: string;
  name: string;
  envVar: string;
  keyMask: string;
  apiKey: string;
}

export interface ProjectState {
  id: string;
  name: string;
  envVar: string;
  keyMask: string;
  apiKey: string;
  client: GoogleGenAI;
  status: "available" | "cooling_down" | "rate_limited" | "disabled";
  cooldownUntil: number;
  consecutiveErrors: number;
  totalSuccessCount: number;
  total429Count: number;
  total503Count: number;
  lastUsedAt: number;
  lastError: string | null;
  lastErrorAt: number | null;
  activeRequestCount: number;
}

export interface SanitizedProjectStatus {
  id: string;
  name: string;
  envVar: string;
  keyMask: string;
  status: "available" | "cooling_down" | "rate_limited" | "disabled";
  cooldownSecondsRemaining: number;
  consecutiveErrors: number;
  totalSuccessCount: number;
  total429Count: number;
  total503Count: number;
  lastUsedAgoSeconds: number | null;
  lastError: string | null;
}

/**
 * Extracts and sanitizes the retry delay from Gemini API error responses or strings.
 */
export function extractRetryDelayMs(err: any): number | null {
  if (!err) return null;
  const errStr = String(err.message || "").toLowerCase();

  // 1. Inspect structured RPC RetryInfo details
  if (err.details && Array.isArray(err.details)) {
    const retryInfo = err.details.find(
      (d: any) => d["@type"]?.includes("RetryInfo") || d.retryDelay
    );
    if (retryInfo && retryInfo.retryDelay) {
      const parsed = parseFloat(String(retryInfo.retryDelay).replace("s", ""));
      if (!isNaN(parsed) && parsed > 0) {
        return Math.ceil(parsed * 1000) + 1500;
      }
    }
  }

  // 2. Regex fallback for "retry in 13.51s", "retry after 24s", "try again in 10s", etc.
  const match =
    errStr.match(/retry in ([0-9.]+)\s*s/) ||
    errStr.match(/retry after ([0-9.]+)\s*s/) ||
    errStr.match(/try again in ([0-9.]+)\s*s/) ||
    errStr.match(/wait ([0-9.]+)\s*s/);
  if (match && match[1]) {
    const parsed = parseFloat(match[1]);
    if (!isNaN(parsed) && parsed > 0) {
      return Math.ceil(parsed * 1000) + 1200;
    }
  }

  return null;
}

/**
 * Detects if an error is an upstream 503 spike or temporary model demand overload.
 */
export function is503OrHighDemand(error: any): boolean {
  if (!error) return false;
  const status = error?.status || error?.statusCode || error?.code;
  if (status === 503 || status === 502) return true;

  const errStr = String(error?.message || "").toLowerCase();
  const details = typeof error?.details === "string" ? error.details.toLowerCase() : "";
  const combined = `${errStr} ${details}`;

  try {
    if (typeof error?.message === "string" && error.message.trim().startsWith("{")) {
      const parsed = JSON.parse(error.message);
      if (parsed?.error?.code === 503 || parsed?.error?.status === "UNAVAILABLE") {
        return true;
      }
    }
  } catch {}

  return (
    combined.includes("503") ||
    combined.includes("high demand") ||
    combined.includes("model is overloaded") ||
    combined.includes("the model is currently overloaded") ||
    combined.includes("upstream model experiences temporary high demand") ||
    combined.includes("overloaded") ||
    combined.includes("service unavailable") ||
    combined.includes("temporarily unavailable") ||
    combined.includes("temporary high demand") ||
    combined.includes("capacity exceeded") ||
    combined.includes("server is busy") ||
    combined.includes("unavailable") ||
    combined.includes("backend error")
  );
}

/**
 * Clean human-readable error formatter (avoids raw JSON or token dumps)
 */
export function formatCleanErrorMessage(rawErr: any): string {
  const msg = rawErr?.message || String(rawErr);
  try {
    const parsed = JSON.parse(msg);
    if (parsed.error?.message) {
      if (
        parsed.error.code === 504 ||
        parsed.error.status === "DEADLINE_EXCEEDED" ||
        parsed.error.message.includes("Deadline expired") ||
        parsed.error.message.includes("504")
      ) {
        return "AI translation timed out (Google Gemini 504 Deadline Exceeded). Please retry in a moment.";
      }
      const firstLine = parsed.error.message.split("\n")[0].trim();
      return firstLine || parsed.error.message;
    }
  } catch {
    // Not a JSON string
  }

  if (
    msg.includes("DEADLINE_EXCEEDED") ||
    msg.includes("Deadline expired") ||
    (msg.includes("504") && msg.includes("Gateway"))
  ) {
    return "AI translation timed out (Google Gemini 504 Deadline Exceeded). Please retry in a moment.";
  }

  return msg.length > 200 ? msg.slice(0, 200) + "..." : msg;
}

/**
 * Multi-Project Quota-Aware Key Scheduler
 * Intelligently balances requests across multiple Google Cloud project API keys,
 * tracks per-project rate limits and cooldowns, and fails over immediately without stalls.
 */
export class QuotaAwareKeyScheduler {
  private projects: Map<string, ProjectState> = new Map();
  private lastSelectedProjectId: string | null = null;

  constructor(
    customKeys?:
      | Array<{ envVar: string; apiKey: string; name?: string }>
      | string[]
      | { keys: string[]; defaultCooldownMs?: number }
  ) {
    this.discoverKeys(customKeys);
  }

  /**
   * Discovers and registers API keys from environment variables or custom input.
   */
  public discoverKeys(
    customKeys?:
      | Array<{ envVar: string; apiKey: string; name?: string }>
      | string[]
      | { keys: string[]; defaultCooldownMs?: number }
  ): void {
    this.projects.clear();
    const candidateKeys: Array<{ envVar: string; apiKey: string; name?: string }> = [];

    if (customKeys) {
      if (Array.isArray(customKeys)) {
        customKeys.forEach((item, idx) => {
          if (typeof item === "string") {
            candidateKeys.push({
              envVar: `CUSTOM_KEY_${idx + 1}`,
              apiKey: item,
              name: `Project #${idx + 1}`,
            });
          } else {
            candidateKeys.push(item);
          }
        });
      } else if (customKeys && typeof customKeys === "object" && Array.isArray((customKeys as any).keys)) {
        (customKeys as any).keys.forEach((key: string, idx: number) => {
          candidateKeys.push({
            envVar: `PROJECT_KEY_${idx + 1}`,
            apiKey: key,
            name: `Project #${idx + 1}`,
          });
        });
      }
    } else {
      // 1. Numbered project keys: GEMINI_API_KEY_1 to GEMINI_API_KEY_10
      for (let i = 1; i <= 10; i++) {
        const envVar = `GEMINI_API_KEY_${i}`;
        const raw = process.env[envVar];
        const val = raw ? raw.trim().replace(/^["']|["']$/g, "") : "";
        if (val && val !== "MY_GEMINI_API_KEY" && val.length >= 8) {
          candidateKeys.push({ envVar, apiKey: val, name: `Project #${i}` });
        }
      }

      // 2. Comma-separated list in GEMINI_API_KEYS
      const commaSeparated = process.env.GEMINI_API_KEYS?.trim().replace(/^["']|["']$/g, "");
      if (commaSeparated) {
        const parts = commaSeparated.split(",").map((k) => k.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
        parts.forEach((k, idx) => {
          if (k.length >= 8 && k !== "MY_GEMINI_API_KEY") {
            candidateKeys.push({
              envVar: `GEMINI_API_KEYS[${idx + 1}]`,
              apiKey: k,
              name: `Project #${candidateKeys.length + 1}`,
            });
          }
        });
      }

      // 3. Fallback default GEMINI_API_KEY
      const defaultKeyRaw = process.env.GEMINI_API_KEY;
      const defaultKey = defaultKeyRaw ? defaultKeyRaw.trim().replace(/^["']|["']$/g, "") : "";
      if (defaultKey && defaultKey !== "MY_GEMINI_API_KEY" && defaultKey.length >= 8) {
        candidateKeys.push({
          envVar: "GEMINI_API_KEY",
          apiKey: defaultKey,
          name: candidateKeys.length === 0 ? "Primary Project" : `Project #${candidateKeys.length + 1}`,
        });
      }
    }

    // Deduplicate by key value
    const seenKeys = new Set<string>();
    let projectCounter = 1;

    for (const candidate of candidateKeys) {
      if (seenKeys.has(candidate.apiKey)) continue;
      seenKeys.add(candidate.apiKey);

      const id = `project-${projectCounter}`;
      const name = candidate.name || `Project #${projectCounter}`;
      const keyMask = candidate.apiKey.length > 10
        ? `${candidate.apiKey.slice(0, 6)}...${candidate.apiKey.slice(-4)}`
        : "configured";

      const client = new GoogleGenAI({
        apiKey: candidate.apiKey,
        httpOptions: {
          headers: {
            "User-Agent": "aistudio-build",
          },
          timeout: 35000,
        },
      });

      this.projects.set(id, {
        id,
        name,
        envVar: candidate.envVar,
        keyMask,
        apiKey: candidate.apiKey,
        client,
        status: "available",
        cooldownUntil: 0,
        consecutiveErrors: 0,
        totalSuccessCount: 0,
        total429Count: 0,
        total503Count: 0,
        lastUsedAt: 0,
        lastError: null,
        lastErrorAt: null,
        activeRequestCount: 0,
      });

      projectCounter++;
    }

    console.log(
      `[Quota Scheduler] Initialized with ${this.projects.size} active Google Cloud project key(s).`
    );
  }

  /**
   * Total number of configured projects.
   */
  public get projectCount(): number {
    return this.projects.size;
  }

  /**
   * Total number of projects that are not permanently disabled (e.g. valid credentials).
   */
  public get enabledProjectCount(): number {
    return Array.from(this.projects.values()).filter((p) => p.status !== "disabled").length;
  }

  /**
   * Returns the project by ID or first available project.
   */
  public getProject(projectId: string): ProjectState | undefined {
    return this.projects.get(projectId);
  }

  /**
   * Acquires a request slot on a project to enforce 1 active request per key.
   */
  public acquireProject(projectId: string): void {
    const p = this.projects.get(projectId);
    if (p) {
      p.activeRequestCount = (p.activeRequestCount || 0) + 1;
      p.lastUsedAt = Date.now();
    }
  }

  /**
   * Releases a request slot on a project when API call completes or fails.
   */
  public releaseProject(projectId: string): void {
    const p = this.projects.get(projectId);
    if (p) {
      p.activeRequestCount = Math.max(0, (p.activeRequestCount || 1) - 1);
    }
  }

  /**
   * Checks if there are other active (non-disabled) projects available
   * that are not in the excludeProjectIds set.
   */
  public hasOtherActiveProjects(excludeProjectIds: Set<string> = new Set()): boolean {
    const enabled = Array.from(this.projects.values()).filter((p) => p.status !== "disabled");
    return enabled.some((p) => !excludeProjectIds.has(p.id));
  }

  /**
   * Returns the count of active (non-disabled) projects not currently excluded.
   */
  public getAvailableProjectsCount(excludeProjectIds: Set<string> = new Set()): number {
    const enabled = Array.from(this.projects.values()).filter((p) => p.status !== "disabled");
    return enabled.filter((p) => !excludeProjectIds.has(p.id)).length;
  }

  /**
   * Intelligent Quota-Aware Selection.
   * Selects an available project key that is NOT in cooldown, prioritizing least-recently-used
   * to balance load without assuming rigid quotas.
   *
   * Enforces 1 active request per Gemini project key at a time.
   * If all projects are cooling down or currently processing a request, returns waitMs.
   */
  public selectProject(excludeProjectIds: Set<string> = new Set()): {
    project: ProjectState;
    waitMs: number;
  } {
    if (this.projects.size === 0) {
      this.discoverKeys();
      if (this.projects.size === 0) {
        throw new Error(
          "No Gemini API keys are configured. Please set GEMINI_API_KEY_1 (or GEMINI_API_KEY) in your environment variables."
        );
      }
    }

    const now = Date.now();
    const enabledProjects = Array.from(this.projects.values()).filter((p) => p.status !== "disabled");

    if (enabledProjects.length === 0) {
      // If all projects were marked disabled, give one last chance by re-enabling them if > 5 minutes have passed
      const allProjects = Array.from(this.projects.values());
      const hasOldDisabled = allProjects.some((p) => p.lastErrorAt && now - p.lastErrorAt > 5 * 60 * 1000);
      if (hasOldDisabled) {
        for (const p of allProjects) {
          p.status = "available";
          p.cooldownUntil = 0;
          p.consecutiveErrors = 0;
        }
        return this.selectProject(new Set());
      }
      throw new Error(
        "All configured Gemini API keys are currently disabled due to authentication errors (401/403 Invalid Key). Please check your GEMINI_API_KEY credentials."
      );
    }

    const eligibleProjects: ProjectState[] = [];

    for (const p of enabledProjects) {
      if (excludeProjectIds.has(p.id)) continue;

      // Refresh status if cooldown expired
      if (p.cooldownUntil > 0 && now >= p.cooldownUntil) {
        p.cooldownUntil = 0;
        p.status = "available";
      }
      eligibleProjects.push(p);
    }

    // If all eligible projects were excluded in this turn, clear exclusion to prevent complete blockage
    const pool = eligibleProjects.length > 0 ? eligibleProjects : enabledProjects;

    // 1. Prioritize completely idle ready projects (activeRequestCount === 0 and cooldown expired)
    const idleProjects = pool.filter((p) => now >= p.cooldownUntil && (p.activeRequestCount || 0) === 0);

    if (idleProjects.length > 0) {
      // Pick the least recently used ready project (lowest lastUsedAt)
      idleProjects.sort((a, b) => {
        if (a.consecutiveErrors !== b.consecutiveErrors) {
          return a.consecutiveErrors - b.consecutiveErrors;
        }
        return a.lastUsedAt - b.lastUsedAt;
      });

      const selected = idleProjects[0];
      this.lastSelectedProjectId = selected.id;
      return { project: selected, waitMs: 0 };
    }

    // 2. Instant Failover Priority: Select any non-rate-limited project (not 429) with activeRequestCount === 0.
    // This allows instant failover during 503 spikes without stalling the queue on brief transient cooldowns!
    const nonRateLimitedIdle = pool.filter(
      (p) => p.status !== "rate_limited" && (p.activeRequestCount || 0) === 0
    );
    if (nonRateLimitedIdle.length > 0) {
      nonRateLimitedIdle.sort((a, b) => {
        if (a.consecutiveErrors !== b.consecutiveErrors) {
          return a.consecutiveErrors - b.consecutiveErrors;
        }
        return a.lastUsedAt - b.lastUsedAt;
      });
      const selected = nonRateLimitedIdle[0];
      this.lastSelectedProjectId = selected.id;
      return { project: selected, waitMs: 0 };
    }

    // 3. If all projects are busy, allow a second concurrent slot (activeRequestCount < 2) to prevent serialization stalls
    const lightlyLoadedProjects = pool.filter((p) => now >= p.cooldownUntil && (p.activeRequestCount || 0) < 2);
    if (lightlyLoadedProjects.length > 0) {
      lightlyLoadedProjects.sort((a, b) => {
        if (a.consecutiveErrors !== b.consecutiveErrors) {
          return a.consecutiveErrors - b.consecutiveErrors;
        }
        return (a.activeRequestCount || 0) - (b.activeRequestCount || 0);
      });
      const selected = lightlyLoadedProjects[0];
      this.lastSelectedProjectId = selected.id;
      return { project: selected, waitMs: 0 };
    }

    // 4. Any non-rate-limited project with activeRequestCount < 2 (bypasses 503 transient cooldowns)
    const nonRateLimitedLight = pool.filter(
      (p) => p.status !== "rate_limited" && (p.activeRequestCount || 0) < 2
    );
    if (nonRateLimitedLight.length > 0) {
      nonRateLimitedLight.sort((a, b) => (a.activeRequestCount || 0) - (b.activeRequestCount || 0));
      const selected = nonRateLimitedLight[0];
      this.lastSelectedProjectId = selected.id;
      return { project: selected, waitMs: 0 };
    }

    // 5. If projects are ready but currently at max capacity (activeRequestCount >= 2), wait briefly for an in-flight request to release key
    const readyButBusy = pool.filter((p) => now >= p.cooldownUntil && (p.activeRequestCount || 0) >= 2);
    if (readyButBusy.length > 0) {
      readyButBusy.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
      const busiest = readyButBusy[0];
      this.lastSelectedProjectId = busiest.id;
      return { project: busiest, waitMs: 150 };
    }

    // 6. All active projects are currently in true rate limit cooldown. Pick the one that will be ready soonest.
    pool.sort((a, b) => a.cooldownUntil - b.cooldownUntil);
    const soonest = pool[0] || enabledProjects[0];
    const waitMs = Math.max(0, soonest.cooldownUntil - now);

    this.lastSelectedProjectId = soonest.id;
    return { project: soonest, waitMs };
  }

  /**
   * Records a successful API call for a project.
   */
  public recordSuccess(projectId: string): void {
    const p = this.projects.get(projectId);
    if (!p) return;

    p.consecutiveErrors = 0;
    p.totalSuccessCount++;
    p.lastUsedAt = Date.now();
    p.cooldownUntil = 0;
    p.status = "available";
  }

  /**
   * Records an upstream temporary high demand spike (503 Service Unavailable / Overloaded).
   * Implements instant multi-project failover dynamics:
   * - Increments total503Count and consecutive errors.
   * - Sets a tiny micro-cooldown (500ms) only so sibling active projects take immediate precedence.
   * - Returns delayMs: 0 and canInstantFailover so the scheduler immediately routes to other projects without stalling the queue.
   */
  public record503Spike(
    projectId: string,
    error?: any
  ): { delayMs: number; canInstantFailover: boolean } {
    const p = this.projects.get(projectId);
    if (!p) {
      return { delayMs: 0, canInstantFailover: false };
    }

    p.total503Count++;
    p.consecutiveErrors++;
    p.lastError = error ? formatCleanErrorMessage(error) : "Temporary high demand (503 spike)";
    p.lastErrorAt = Date.now();
    p.status = "cooling_down";
    // Short micro-cooldown (500ms) to prioritize sibling active projects without stalling queue
    p.cooldownUntil = Date.now() + 500;

    const canInstantFailover = this.enabledProjectCount > 1;

    console.warn(
      `[Quota Scheduler] 503 Spike recorded on ${p.name} (${p.keyMask}). Total 503 spikes: ${p.total503Count}. Failover available: ${canInstantFailover}.`
    );

    return { delayMs: 0, canInstantFailover };
  }

  /**
   * Records a rate-limit (429) or transient (503/500) error for a project,
   * calculating adaptive or exact cooldowns based on API headers.
   */
  public recordFailure(
    projectId: string,
    error: any
  ): { delayMs: number; isRateLimit: boolean; isTemporary: boolean } {
    const p = this.projects.get(projectId);
    if (!p) {
      return { delayMs: 5000, isRateLimit: false, isTemporary: false };
    }

    const errStr = String(error?.message || "").toLowerCase();

    // 1. Check Rate Limit / Quota FIRST (handles HTTP 429 & 403 Quota/ResourceExhausted)
    const isRateLimit =
      error?.status === 429 ||
      error?.statusCode === 429 ||
      error?.code === 429 ||
      error?.status === "RESOURCE_EXHAUSTED" ||
      errStr.includes("429") ||
      errStr.includes("resource_exhausted") ||
      errStr.includes("quota") ||
      errStr.includes("rate limit") ||
      errStr.includes("rate-limit") ||
      errStr.includes("rate_limit") ||
      errStr.includes("rate-limits") ||
      errStr.includes("exceeded your current quota") ||
      errStr.includes("too many requests");

    // 2. Check Auth / Invalid Key (strictly when NOT a rate/quota limit)
    const isAuthOrInvalidKey =
      !isRateLimit &&
      (error?.status === 401 ||
        error?.statusCode === 401 ||
        errStr.includes("401") ||
        errStr.includes("unauthenticated") ||
        errStr.includes("invalid authentication credentials") ||
        errStr.includes("access_token_type_unsupported") ||
        errStr.includes("api key not valid") ||
        errStr.includes("api_key_invalid") ||
        (errStr.includes("invalid") && errStr.includes("key")) ||
        ((error?.status === 403 || error?.statusCode === 403 || errStr.includes("403") || errStr.includes("permission_denied")) &&
          !errStr.includes("quota") &&
          !errStr.includes("limit") &&
          !errStr.includes("exceeded") &&
          !errStr.includes("resource")));

    const is503 = is503OrHighDemand(error);

    const isTemporary =
      is503 ||
      error?.status === 503 ||
      error?.status === 500 ||
      errStr.includes("503") ||
      errStr.includes("500") ||
      errStr.includes("unavailable") ||
      errStr.includes("high demand") ||
      errStr.includes("overloaded");

    p.consecutiveErrors++;
    p.lastError = formatCleanErrorMessage(error);
    p.lastErrorAt = Date.now();

    let delayMs = 5000;

    if (isAuthOrInvalidKey) {
      p.status = "disabled";
      p.cooldownUntil = Date.now() + 60000; // 60s quarantine before auto-probing recovery
      console.warn(
        `[Quota Scheduler] ${p.name} (${p.keyMask}) quarantined for 60s due to authentication/invalid key error.`
      );
    } else if (isRateLimit) {
      p.total429Count++;
      const explicitDelay = extractRetryDelayMs(error);
      if (explicitDelay) {
        delayMs = explicitDelay;
      } else {
        // Adaptive cooldown based on consecutive errors (without assuming fixed RPM/RPD)
        delayMs = Math.min(8000 * Math.pow(1.4, p.consecutiveErrors - 1), 60000);
      }
      p.status = "rate_limited";
      p.cooldownUntil = Date.now() + delayMs;

      console.warn(
        `[Quota Scheduler] ${p.name} (${p.keyMask}) quota limited. Cooldown: ${Math.round(
          delayMs / 1000
        )}s. Rotating to next project...`
      );
    } else if (is503) {
      p.total503Count++;
      // Instant multi-project failover: do not stall with long cooldowns
      delayMs = 0;
      p.status = "cooling_down";
      p.cooldownUntil = Date.now() + 500;

      console.warn(
        `[Quota Scheduler] ${p.name} (${p.keyMask}) temporary high demand spike (503). Micro-cooldown: 500ms. Instant routing enabled.`
      );
    } else if (isTemporary) {
      p.total503Count++;
      delayMs = 1000;
      p.status = "cooling_down";
      p.cooldownUntil = Date.now() + delayMs;

      console.warn(
        `[Quota Scheduler] ${p.name} (${p.keyMask}) temporary server error (500/transient). Cooldown: 1s.`
      );
    } else {
      // General error (e.g. invalid arguments or bad request)
      delayMs = 2000;
      p.cooldownUntil = Date.now() + delayMs;
    }

    return { delayMs, isRateLimit, isTemporary };
  }

  /**
   * Safe status report suitable for UI or health API endpoints.
   * Completely omits actual API keys.
   */
  public getSanitizedStatus(): SanitizedProjectStatus[] {
    const now = Date.now();
    const result: SanitizedProjectStatus[] = [];

    for (const p of this.projects.values()) {
      let status = p.status;
      let cooldownSecondsRemaining = 0;

      if (p.status === "disabled") {
        status = "disabled";
        cooldownSecondsRemaining = 0;
      } else if (p.cooldownUntil > now) {
        cooldownSecondsRemaining = Math.ceil((p.cooldownUntil - now) / 1000);
      } else {
        status = "available";
      }

      const lastUsedAgoSeconds = p.lastUsedAt > 0 ? Math.round((now - p.lastUsedAt) / 1000) : null;

      result.push({
        id: p.id,
        name: p.name,
        envVar: p.envVar,
        keyMask: p.keyMask,
        status,
        cooldownSecondsRemaining,
        consecutiveErrors: p.consecutiveErrors,
        totalSuccessCount: p.totalSuccessCount,
        total429Count: p.total429Count,
        total503Count: p.total503Count,
        lastUsedAgoSeconds,
        lastError: p.lastError,
      });
    }

    return result;
  }

  /**
   * Returns current active project info (sanitized).
   */
  public getActiveProjectSummary(): {
    activeProjectId: string | null;
    activeProjectName: string | null;
    totalConfigured: number;
    availableCount: number;
    coolingDownCount: number;
    nextAvailableInSeconds: number;
    total503Spikes: number;
    instantFailoverAvailable: boolean;
  } {
    const now = Date.now();
    let availableCount = 0;
    let coolingDownCount = 0;
    let minWaitMs = Infinity;
    let total503Spikes = 0;

    for (const p of this.projects.values()) {
      if (p.status === "disabled") continue;
      total503Spikes += p.total503Count || 0;
      if (p.cooldownUntil <= now) {
        availableCount++;
      } else {
        coolingDownCount++;
        minWaitMs = Math.min(minWaitMs, p.cooldownUntil - now);
      }
    }

    const nextAvailableInSeconds =
      availableCount === 0 && coolingDownCount > 0 && minWaitMs !== Infinity
        ? Math.ceil(minWaitMs / 1000)
        : 0;

    const activeProject = this.lastSelectedProjectId
      ? this.projects.get(this.lastSelectedProjectId)
      : null;

    return {
      activeProjectId: activeProject?.id || null,
      activeProjectName: activeProject ? `${activeProject.name} (${activeProject.keyMask})` : null,
      totalConfigured: this.projects.size,
      availableCount,
      coolingDownCount,
      nextAvailableInSeconds,
      total503Spikes,
      instantFailoverAvailable: this.enabledProjectCount > 1,
    };
  }
}

// Export singleton instance for the server
export const quotaScheduler = new QuotaAwareKeyScheduler();
