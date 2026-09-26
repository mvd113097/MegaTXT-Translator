// Dynamic cache for real 52shuku scraped records (Likes, Author, URLs, Year)
export interface ShukuAuthenticEntry {
  likes?: number;
  year?: number;
  author?: string;
  url?: string;
}

// Runtime cache for dynamically scraped items with authentic verified baselines
export const SHUKU_AUTHENTIC_MAP: Record<string, ShukuAuthenticEntry> = {
  "穿去史前搞基建": {
    likes: 41800,
    year: 2020,
    author: "忘却的悠",
    url: "https://www.52shuku.net/jiakong/h2fE.html",
  },
  "原始再来": {
    likes: 38900,
    year: 2017,
    author: "月下桑",
    url: "https://www.52shuku.net/jiakong/bj_1.html",
  },
  "回到原始开荒": {
    likes: 29500,
    year: 2021,
    author: "桃花白茶",
    url: "https://www.52shuku.net/jiakong/b4kX.html",
  },
  "史前男妻": {
    likes: 26800,
    year: 2019,
    author: "温奶茶",
    url: "https://www.52shuku.net/jiakong/h39k.html",
  },
};

