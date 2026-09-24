import axios from "axios";
import * as cheerio from "cheerio";
import https from "https";

const sslAgent = new https.Agent({ rejectUnauthorized: false });

async function testHeaders() {
  const userAgents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0"
  ];

  for (const ua of userAgents) {
    try {
      console.log("Trying UA:", ua.substring(0, 30));
      const res = await axios.get("https://czbooks.net/n/um775", {
        headers: {
          "User-Agent": ua,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7",
          "Cache-Control": "no-cache",
          "Pragma": "no-cache",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "none",
          "Sec-Fetch-User": "?1",
          "Upgrade-Insecure-Requests": "1"
        },
        httpsAgent: sslAgent,
        timeout: 10000
      });
      console.log("Status:", res.status);
      const $ = cheerio.load(res.data);
      console.log("Title:", $(".novel-detail .title").text().trim() || $("h1").first().text().trim());
      const chapters: any[] = [];
      $("ul#chapter-list li a, .chapter-list li a").each((_, el) => {
        chapters.push({ title: $(el).text().trim(), href: $(el).attr("href") });
      });
      console.log("Found chapters:", chapters.length);
      console.log("Ch 35-40:", chapters.slice(34, 40));
      return;
    } catch (e: any) {
      console.log("Failed:", e.message, e.response?.status);
    }
  }
}

testHeaders();
