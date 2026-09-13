import JSZip from "jszip";
import { TextChunk } from "../types";
import { downloadFile } from "./fileDownloader";
import { getContiguousCompletedChunks } from "./chunker";

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export interface EpubOptions {
  bookTitle?: string;
  author?: string;
  language?: string;
  isBilingual?: boolean;
  allowGaps?: boolean; // Default false. When false, strictly enforces contiguous chapters from index 0
}

/**
 * Builds a valid EPUB 3 / EPUB 2 compatible ebook archive from translated chunks.
 * Enforces the Never-Skip contiguous guarantee: only unbroken sequences starting from Chunk 1 are exported.
 */
export async function generateEpubBlob(
  chunks: TextChunk[],
  options: EpubOptions = {}
): Promise<Blob> {
  const zip = new JSZip();
  const bookTitle = options.bookTitle || "Translated Novel";
  const author = options.author || "Web Novel Translator";
  const language = options.language || "en";
  const isBilingual = !!options.isBilingual;

  // Enforce contiguous completion guarantee unless explicitly overridden
  const validChunks = options.allowGaps
    ? chunks.filter((c) => c.englishText && c.englishText.trim().length > 0)
    : getContiguousCompletedChunks(chunks);

  if (validChunks.length === 0) {
    throw new Error(
      "No contiguous translated content available to build EPUB (Chapter 1 must be translated first)."
    );
  }

  // 1. mimetype (MUST be first file, uncompressed STORE)
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });

  // 2. META-INF/container.xml
  const containerXml = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
  zip.file("META-INF/container.xml", containerXml);

  // 3. OEBPS/style.css
  const styleCss = `
@charset "utf-8";
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Georgia, serif;
  line-height: 1.7;
  margin: 4% 5%;
  color: #1e293b;
  background-color: transparent;
}
h1, h2, h3 {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  text-align: center;
  margin-top: 1.8em;
  margin-bottom: 0.8em;
  color: #0f172a;
  font-weight: 700;
  line-height: 1.3;
}
h2 {
  font-size: 1.4em;
  border-bottom: 1px solid #e2e8f0;
  padding-bottom: 0.4em;
}
p {
  text-indent: 1.5em;
  margin-top: 0;
  margin-bottom: 0.7em;
  text-align: justify;
}
p.first-p {
  text-indent: 0;
}
.bilingual-pair {
  margin-bottom: 1.2em;
  padding-bottom: 0.8em;
  border-bottom: 1px dashed #cbd5e1;
}
.chinese-source {
  color: #64748b;
  font-size: 0.9em;
  font-family: "PingFang SC", "Microsoft YaHei", sans-serif;
  margin-bottom: 0.4em;
  text-indent: 0;
}
.english-target {
  color: #0f172a;
  text-indent: 0;
}
.book-title-page {
  text-align: center;
  margin-top: 25%;
}
.book-title-page h1 {
  font-size: 2em;
  margin-bottom: 0.2em;
}
.book-title-page p {
  text-indent: 0;
  text-align: center;
  color: #64748b;
  font-size: 0.95em;
}
`;
  zip.file("OEBPS/style.css", styleCss);

  // 4. Generate Chapter XHTML Files
  const chapterFiles: Array<{ id: string; filename: string; title: string }> = [];

  // Title Page
  const titlePageHtml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${language}">
<head>
  <meta charset="utf-8" />
  <title>${escapeXml(bookTitle)}</title>
  <link rel="stylesheet" type="text/css" href="style.css" />
</head>
<body>
  <div class="book-title-page">
    <h1>${escapeXml(bookTitle)}</h1>
    <p>Translated with AI Web Novel Studio</p>
    <p style="margin-top: 2em; font-size: 0.85em; color: #94a3b8;">Generated on ${escapeXml(new Date().toLocaleDateString())}</p>
    <p style="font-size: 0.85em; color: #94a3b8;">${validChunks.length} Translated Sections</p>
  </div>
</body>
</html>`;
  zip.file("OEBPS/titlepage.xhtml", titlePageHtml);
  chapterFiles.push({ id: "titlepage", filename: "titlepage.xhtml", title: "Title Page" });

  // Helper regex for detecting heading lines in translated English text
  const chapterHeaderPattern =
    /^(?:Chapter\s+[0-9IVXLCDM]+|Prologue|Epilogue|Volume\s+[0-9IVXLCDM]+|Book\s+[0-9IVXLCDM]+|Act\s+[0-9IVXLCDM]+|Part\s+[0-9IVXLCDM]+|Section\s+[0-9IVXLCDM]+|Interlude|Side\s+Story|Extra\s+Chapter|Extra\s+[0-9]+|C\d+[\s:.-]|第\s*[0-9零一二三四五六七八九十百千万]+\s*[章回节卷集部篇])/i;

  for (let i = 0; i < validChunks.length; i++) {
    const chunk = validChunks[i];
    const chapterId = `chapter_${i + 1}`;
    const filename = `${chapterId}.xhtml`;
    
    // Parse paragraphs from English translation
    const allEnParagraphs = chunk.englishText
      ? chunk.englishText.split(/\n+/).map((p) => p.trim()).filter(Boolean)
      : [];

    let displayTitle = chunk.chapterTitle || `Section ${chunk.index + 1}`;
    let bodyEnParagraphs = allEnParagraphs;

    // Check if the translated text begins with an English chapter title heading
    if (allEnParagraphs.length > 0) {
      const firstLine = allEnParagraphs[0];
      const isHeaderLine =
        (chapterHeaderPattern.test(firstLine) && firstLine.length < 120) ||
        (firstLine.length < 60 && !/[.!?…。!?"”'’]$/.test(firstLine) && !firstLine.includes(",") && allEnParagraphs.length > 1);

      if (isHeaderLine) {
        // Use the translated English header as the display title
        const cleanedHeader = firstLine.replace(/^#+\s*/, "").replace(/^\*\*|\*\*$/g, "").trim();
        displayTitle = cleanedHeader;
        bodyEnParagraphs = allEnParagraphs.slice(1);

        // If chunk metadata had a part indicator like (Part 2) that isn't in the heading, append it
        const partMatch = chunk.chapterTitle?.match(/\(Part\s+\d+\)/i);
        if (partMatch && !displayTitle.toLowerCase().includes("part")) {
          displayTitle = `${displayTitle} ${partMatch[0]}`;
        }
      } else if (displayTitle === "Prologue / Introduction" || displayTitle.startsWith("Section ")) {
        // If metadata had a placeholder and first line wasn't standard header, inspect if first line is a short title
        if (firstLine.length < 80 && !/[.!?]$/.test(firstLine)) {
          displayTitle = firstLine;
          bodyEnParagraphs = allEnParagraphs.slice(1);
        }
      }
    }

    const safeTitle = escapeXml(displayTitle);
    let contentHtml = "";

    if (isBilingual) {
      // Bilingual mode: show paired paragraphs
      const zhParagraphs = chunk.chineseText.split(/\n+/).map((p) => p.trim()).filter(Boolean);
      contentHtml += `<h2>${safeTitle}</h2>\n`;
      const maxLen = Math.max(zhParagraphs.length, bodyEnParagraphs.length);
      for (let pIdx = 0; pIdx < maxLen; pIdx++) {
        const zh = zhParagraphs[pIdx] ? escapeXml(zhParagraphs[pIdx]) : "";
        const en = bodyEnParagraphs[pIdx] ? escapeXml(bodyEnParagraphs[pIdx]) : "";
        contentHtml += `<div class="bilingual-pair">\n`;
        if (zh) contentHtml += `  <p class="chinese-source">${zh}</p>\n`;
        if (en) contentHtml += `  <p class="english-target">${en}</p>\n`;
        contentHtml += `</div>\n`;
      }
    } else {
      // Standard English novel text
      contentHtml += `<h2>${safeTitle}</h2>\n`;
      bodyEnParagraphs.forEach((p, pIdx) => {
        const pClass = pIdx === 0 ? ' class="first-p"' : "";
        contentHtml += `<p${pClass}>${escapeXml(p)}</p>\n`;
      });
    }

    const chapterHtml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${language}">
<head>
  <meta charset="utf-8" />
  <title>${safeTitle}</title>
  <link rel="stylesheet" type="text/css" href="style.css" />
</head>
<body>
  ${contentHtml}
</body>
</html>`;

    zip.file(`OEBPS/${filename}`, chapterHtml);
    chapterFiles.push({ id: chapterId, filename, title: displayTitle });
  }

  // 5. OEBPS/nav.xhtml (EPUB 3 Table of Contents)
  const navHtml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${language}">
<head>
  <meta charset="utf-8" />
  <title>Table of Contents</title>
  <link rel="stylesheet" type="text/css" href="style.css" />
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h2>Table of Contents</h2>
    <ol>
      ${chapterFiles
        .map(
          (cf) =>
            `<li><a href="${cf.filename}">${escapeXml(cf.title)}</a></li>`
        )
        .join("\n      ")}
    </ol>
  </nav>
</body>
</html>`;
  zip.file("OEBPS/nav.xhtml", navHtml);

  // 6. OEBPS/toc.ncx (EPUB 2 / Kindle legacy fallback)
  const ncxXml = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:ai-studio-novel-${Date.now()}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle>
    <text>${escapeXml(bookTitle)}</text>
  </docTitle>
  <navMap>
    ${chapterFiles
      .map(
        (cf, idx) => `
    <navPoint id="navPoint-${idx + 1}" playOrder="${idx + 1}">
      <navLabel><text>${escapeXml(cf.title)}</text></navLabel>
      <content src="${cf.filename}"/>
    </navPoint>`
      )
      .join("")}
  </navMap>
</ncx>`;
  zip.file("OEBPS/toc.ncx", ncxXml);

  // 7. OEBPS/content.opf
  const bookId = `urn:uuid:novel-trans-${Date.now()}`;
  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  const contentOpf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="BookId">${bookId}</dc:identifier>
    <dc:title>${escapeXml(bookTitle)}</dc:title>
    <dc:language>${language}</dc:language>
    <dc:creator>${escapeXml(author)}</dc:creator>
    <dc:date>${nowIso}</dc:date>
    <meta property="dcterms:modified">${nowIso}</meta>
  </metadata>
  <manifest>
    <item id="style" href="style.css" media-type="text/css"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    ${chapterFiles
      .map(
        (cf) =>
          `<item id="${cf.id}" href="${cf.filename}" media-type="application/xhtml+xml"/>`
      )
      .join("\n    ")}
  </manifest>
  <spine toc="ncx">
    ${chapterFiles.map((cf) => `<itemref idref="${cf.id}"/>`).join("\n    ")}
  </spine>
</package>`;
  zip.file("OEBPS/content.opf", contentOpf);

  // Generate the blob with proper EPUB MIME type
  return await zip.generateAsync({
    type: "blob",
    mimeType: "application/epub+zip",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });
}

/**
 * Triggers a browser download of an EPUB file
 */
export async function downloadEpub(
  chunks: TextChunk[],
  rawFileName: string,
  options: EpubOptions = {}
): Promise<{ filename: string; downloadUrl?: string }> {
  const baseName = rawFileName.replace(/\.[^/.]+$/, "") || "translated_novel";
  const suffix = options.isBilingual ? "_bilingual" : "";
  const downloadFileName = `${baseName}${suffix}.epub`;

  const blob = await generateEpubBlob(chunks, {
    bookTitle: baseName.replace(/_/g, " "),
    ...options,
  });

  const res = await downloadFile(blob, downloadFileName, "application/epub+zip");
  return {
    filename: downloadFileName,
    downloadUrl: res.downloadUrl,
  };
}
