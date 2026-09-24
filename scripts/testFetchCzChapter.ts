import axios from "axios";
import * as cheerio from "cheerio";
import https from "https";

const sslAgent = new https.Agent({ rejectUnauthorized: false });

async function testFetchCzChapter() {
  const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
  const url = "https://czbooks.net/n/um775/u93ln"; // Chapter 37
  try {
    const res = await axios.get(url, {
      headers: {
        "User-Agent": ua,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7",
        "Referer": "https://czbooks.net/n/um775"
      },
      httpsAgent: sslAgent,
      timeout: 10000
    });
    const $ = cheerio.load(res.data);
    const title = $(".chapter-detail .title, .title, h1").first().text().trim();
    const content = $(".content").text().trim();
    console.log("Fetched successfully!");
    console.log("Title:", title);
    console.log("Content length:", content.length);
    console.log("Content snippet:\n", content.slice(0, 300));
  } catch (err: any) {
    console.error("Fetch failed:", err.message);
  }
}

testFetchCzChapter();
