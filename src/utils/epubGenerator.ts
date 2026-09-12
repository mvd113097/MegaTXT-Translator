import JSZip from "jszip";
import { TextChunk } from "../types";
import { downloadFile } from "./fileDownloader";

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
}

/**
 * Builds a valid EPUB 3 / EPUB 2 compatible ebook archive from translated chunks
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

  const validChunks = chunks.filter(
    (c) => c.englishText && c.englishText.trim().length > 0
  );

  if (validChunks.length === 0) {
    throw new Error("No translated content available to build EPUB.");
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

  for (let i = 0; i < validChunks.length; i++) {
    const chunk = validChunks[i];
    const chapterId = `chapter_${i + 1}`;
    const filename = `${chapterId}.xhtml`;
    const rawTitle = chunk.chapterTitle || `Section ${chunk.index + 1}`;
    const safeTitle = escapeXml(rawTitle);

    let contentHtml = "";

    if (isBilingual) {
      // Bilingual mode: show paired paragraphs
      const zhParagraphs = chunk.chineseText.split(/\n+/).filter((p) => p.trim());
      const enParagraphs = chunk.englishText.split(/\n+/).filter((p) => p.trim());

      contentHtml += `<h2>${safeTitle}</h2>\n`;
      const maxLen = Math.max(zhParagraphs.length, enParagraphs.length);
      for (let pIdx = 0; pIdx < maxLen; pIdx++) {
        const zh = zhParagraphs[pIdx] ? escapeXml(zhParagraphs[pIdx].trim()) : "";
        const en = enParagraphs[pIdx] ? escapeXml(enParagraphs[pIdx].trim()) : "";
        contentHtml += `<div class="bilingual-pair">\n`;
        if (zh) contentHtml += `  <p class="chinese-source">${zh}</p>\n`;
        if (en) contentHtml += `  <p class="english-target">${en}</p>\n`;
        contentHtml += `</div>\n`;
      }
    } else {
      // Standard English novel text
      contentHtml += `<h2>${safeTitle}</h2>\n`;
      const paragraphs = chunk.englishText.split(/\n+/).filter((p) => p.trim());
      paragraphs.forEach((p, pIdx) => {
        const pClass = pIdx === 0 ? ' class="first-p"' : "";
        contentHtml += `<p${pClass}>${escapeXml(p.trim())}</p>\n`;
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
    chapterFiles.push({ id: chapterId, filename, title: rawTitle });
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
