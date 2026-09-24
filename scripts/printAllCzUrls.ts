import axios from "axios";
import * as cheerio from "cheerio";
import https from "https";

const sslAgent = new https.Agent({ rejectUnauthorized: false });

async function printAllCzUrls() {
  const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
  const res = await axios.get("https://czbooks.net/n/um775", {
    headers: {
      "User-Agent": ua,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7",
    },
    httpsAgent: sslAgent,
    timeout: 10000
  });
  const $ = cheerio.load(res.data);
  const chapters: any[] = [];
  $("ul#chapter-list li a, .chapter-list li a").each((i, el) => {
    chapters.push({ index: i + 1, title: $(el).text().trim(), href: $(el).attr("href") });
  });

  console.log("Total chapters in TOC:", chapters.length);
  console.log("Chapters 35-50:", chapters.slice(34, 50));
  console.log("Chapters 80-90:", chapters.slice(79, 90));

  // Let's test fetching chapters 35-40 with proper URL
  for (let i = 35; i <= 40; i++) {
    const ch = chapters[i - 1];
    let fullUrl = ch.href;
    if (fullUrl.startsWith("//")) fullUrl = "https:" + fullUrl;
    else if (!fullUrl.startsWith("http")) fullUrl = "https://czbooks.net" + fullUrl;

    try {
      // Add small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 200));
      const chRes = await axios.get(fullUrl, {
        headers: {
          "User-Agent": ua,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7",
          "Referer": "https://czbooks.net/n/um775"
        },
        httpsAgent: sslAgent,
        timeout: 10000
      });
      const $ch = cheerio.load(chRes.data);
      const text = $ch(".content").text().trim();
      console.log(`Ch ${i} (${ch.title}): length = ${text.length}`);
    } catch (e: any) {
      console.log(`Ch ${i} (${ch.title}) ERROR: ${e.message} status=${e.response?.status}`);
    }
  }
}

printAllCzUrls();
