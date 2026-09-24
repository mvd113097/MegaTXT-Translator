import { fetchNovelTOC, fetchChapterText } from "../server/storeScraper";

async function testCz() {
  console.log("Fetching CZBooks TOC...");
  const toc = await fetchNovelTOC("https://czbooks.net/n/um775", "czbooks");
  console.log(`TOC title: ${toc.title}, chapters count: ${toc.chapters.length}`);
  console.log("First 3 chapters:", toc.chapters.slice(0, 3));
  console.log("Chapters 35-40:", toc.chapters.slice(34, 40));
  console.log("Chapters 80-88:", toc.chapters.slice(79, 88));

  console.log("\nTesting chapter text fetches for chapters 36, 37, 38, 50, 86...");
  for (const idx of [36, 37, 38, 50, 86]) {
    const ch = toc.chapters[idx - 1];
    if (ch) {
      const text = await fetchChapterText(ch.url);
      console.log(`Ch ${idx} [${ch.title}]: len=${text.length}, snippet=${text.slice(0, 50).replace(/\n/g, " ")}`);
    } else {
      console.log(`Ch ${idx}: NOT IN TOC`);
    }
  }
}

testCz();
