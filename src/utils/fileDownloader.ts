/**
 * Safe, robust file download utility designed for both top-level windows
 * and restricted / sandboxed iframes.
 */

export interface DownloadResult {
  success: boolean;
  filename: string;
  downloadUrl?: string;
  isIframe: boolean;
  method: "client" | "server" | "both";
  error?: string;
}

// Convert a Blob to Base64 string
export async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result as string;
      // strip "data:*/*;base64," prefix
      const base64 = dataUrl.split(",")[1] || "";
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Downloads any text or binary content reliably.
 * 1. Prepares server-side endpoint for direct HTTP attachment download (bypasses iframe sandbox).
 * 2. Triggers client-side Object URL download with delayed revocation (does not abort download).
 * 3. Returns the server download URL so UI can show a fallback direct link.
 */
export async function downloadFile(
  content: Blob | string,
  filename: string,
  mimeType = "text/plain;charset=utf-8"
): Promise<DownloadResult> {
  const isIframe = typeof window !== "undefined" && window.self !== window.top;
  const isBlob = content instanceof Blob;
  const blob = isBlob ? content : new Blob(["\uFEFF" + content], { type: mimeType });

  let serverDownloadUrl = "";

  // 1. Prepare server download endpoint
  try {
    let payloadContent = "";
    let isBase64 = false;

    if (isBlob) {
      payloadContent = await blobToBase64(blob);
      isBase64 = true;
    } else {
      payloadContent = content as string;
      isBase64 = false;
    }

    const res = await fetch("/api/prepare-download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename,
        contentType: mimeType,
        content: payloadContent,
        isBase64,
      }),
    });

    if (res.ok) {
      const data = await res.json();
      if (data.downloadUrl) {
        serverDownloadUrl = data.downloadUrl;
      }
    }
  } catch (err) {
    console.warn("Could not register server download endpoint, falling back to pure client-side:", err);
  }

  // 2. Client-side Blob download trigger (with SAFE 2-minute delayed revocation!)
  try {
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = filename;
    link.setAttribute("style", "display: none;");
    document.body.appendChild(link);
    link.click();

    // Remove element from DOM
    setTimeout(() => {
      if (document.body.contains(link)) {
        document.body.removeChild(link);
      }
    }, 100);

    // CRITICAL: Delay URL revocation by 2 minutes so browser has ample time to complete download
    setTimeout(() => {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
        // ignore
      }
    }, 120000);
  } catch (err) {
    console.error("Client-side download trigger failed:", err);
  }

  // 3. If in iframe or server URL available, attempt navigation via anchor
  if (isIframe && serverDownloadUrl) {
    // If the sandboxed iframe blocked the client blob download, clicking a server attachment link
    // with target="_blank" opens a top-level context where the download starts automatically
    try {
      const backupLink = document.createElement("a");
      backupLink.href = serverDownloadUrl;
      backupLink.target = "_blank";
      backupLink.rel = "noopener noreferrer";
      backupLink.setAttribute("style", "display: none;");
      document.body.appendChild(backupLink);
      backupLink.click();
      setTimeout(() => {
        if (document.body.contains(backupLink)) {
          document.body.removeChild(backupLink);
        }
      }, 500);
    } catch {
      // ignore
    }
  }

  return {
    success: true,
    filename,
    downloadUrl: serverDownloadUrl,
    isIframe,
    method: serverDownloadUrl ? "both" : "client",
  };
}
