import axios from "axios";
import * as cheerio from "cheerio";
import https from "https";

const sslAgent = new https.Agent({ rejectUnauthorized: false });

async function testFetchChapters() {
  const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
  const chs = [
    { num: 36, url: "https://czbooks.net/n/um775/u93l1" },
    { num: 37, url: "https://czbooks.net/n/um775/u93ln" },
    { num: 38, url: "https://czbooks.net/n/um775/u93km" },
    { num: 50, url: "https://czbooks.net/n/um775/u93m9" },
    { num: 86, url: "https://czbooks.net/n/um775/u93b1" }
  ];

  for (const c of chs) {
    try {
      const res = await axios.get(c.url, {
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
      const content = $(".content").text().trim();
      console.log(`Chapter ${c.num} (${c.url}) -> length: ${content.length} chars`);
      console.log(`Preview:`, content.substring(0, 100));
    } catch (e: any) {
      console.log(`Chapter ${c.num} failed:`, e.message, e.response?.status);
    }
  }
}

testFetchChapters();
