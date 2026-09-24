import axios from "axios";
import * as cheerio from "cheerio";
import https from "https";

const sslAgent = new https.Agent({ rejectUnauthorized: false });

async function testSession() {
  const client = axios.create({
    httpsAgent: sslAgent,
    timeout: 10000,
    headers: {
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7",
    }
  });

  try {
    console.log("1. Visiting main novel page...");
    const res1 = await client.get("https://czbooks.net/n/um775");
    console.log("Main page status:", res1.status);
    const cookies = res1.headers["set-cookie"];
    console.log("Set-Cookie:", cookies);

    const cookieHeader = cookies ? cookies.map(c => c.split(";")[0]).join("; ") : "";

    console.log("2. Visiting chapter 37 with cookies & referer...");
    const res2 = await client.get("https://czbooks.net/n/um775/u93ln", {
      headers: {
        "Referer": "https://czbooks.net/n/um775",
        "Cookie": cookieHeader
      }
    });
    console.log("Chapter 37 status:", res2.status);
    const $ = cheerio.load(res2.data);
    const text = $(".content").text().trim();
    console.log("Chapter 37 text length:", text.length);
    console.log("Chapter 37 preview:", text.slice(0, 200));
  } catch (e: any) {
    console.log("Session error:", e.message, e.response?.status);
  }
}

testSession();
