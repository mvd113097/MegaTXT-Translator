import { searchStoreNovels, fetchNovelTOC, fetchChapterText } from "../server/storeScraper";

async function testAllSites() {
  const titles = ["回到石器时代", "回到舊石器時代", "回到原始社会", "回到石器時代"];
  for (const t of titles) {
    console.log(`\n=== Searching for: ${t} ===`);
    const results = await searchStoreNovels(t, "all");
    console.log(`Found ${results.length} results:`);
    for (const r of results.slice(0, 8)) {
      console.log(`- [${r.siteId}] "${r.title}" by ${r.author} -> ${r.novelUrl}`);
    }
  }
}

testAllSites();
