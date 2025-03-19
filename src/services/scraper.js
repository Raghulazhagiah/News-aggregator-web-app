const axios = require("axios");
const cheerio = require("cheerio");
const natural = require("natural");
const cron = require("node-cron");

// Initialize sentiment analyzer
const analyzer = new natural.SentimentAnalyzer(
  "English",
  natural.PorterStemmer,
  "afinn"
);

// Store scraped news
let newsCache = [];

const sources = [
  {
    name: "Times of India",
    url: "https://timesofindia.indiatimes.com/rssfeedstopstories.cms",
    type: "rss",
  },
  {
    name: "NDTV",
    url: "https://feeds.feedburner.com/ndtvnews-top-stories",
    type: "rss",
  },
  {
    name: "Hindustan Times",
    url: "https://www.hindustantimes.com/india-news",
    selectors: {
      articles: ".storyCard, .hdg3",
      title: "h3 a, .hdg3 a",
      content: ".detail, .storyDetail, .sortDec, .storyParagraph",
      link: "h3 a, .hdg3 a",
    },
  },
  {
    name: "India Today",
    url: "https://www.indiatoday.in/india",
    selectors: {
      articles: "div.story__grid article",
      title: "h2.story__title a",
      content: "p.story__description",
      link: "h2.story__title a",
    },
  },
  {
    name: "The Hindu",
    url: "https://www.thehindu.com/latest-news/",
    selectors: {
      articles: ".timeline-container .timeline-item",
      title: ".title a, h3 a",
      content: ".intro, .story-card-text",
      link: ".title a, h3 a",
    },
  },
];

// Add more robust headers and cookies
const axiosConfig = {
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    Connection: "keep-alive",
    "Cache-Control": "max-age=0",
    "Sec-Ch-Ua":
      '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    Referer: "https://www.indiatoday.in",
  },
  timeout: 15000,
  withCredentials: true,
};

const categorizeArticle = (text) => {
  const topics = {
    politics: [
      "government",
      "minister",
      "election",
      "party",
      "parliament",
      "policy",
      "congress",
      "bjp",
      "political",
      "leader",
      "democracy",
      "vote",
      "campaign",
    ],
    health: [
      "hospital",
      "medical",
      "health",
      "disease",
      "covid",
      "doctor",
      "vaccine",
      "treatment",
      "patient",
      "medicine",
      "healthcare",
      "wellness",
      "clinic",
    ],
    world: [
      "international",
      "global",
      "foreign",
      "world",
      "diplomatic",
      "embassy",
      "overseas",
      "bilateral",
      "multinational",
      "united nations",
      "summit",
      "treaty",
    ],
  };

  const words = text.toLowerCase().split(" ");
  const scores = {};

  Object.keys(topics).forEach((topic) => {
    scores[topic] = words.filter((word) =>
      topics[topic].some((keyword) => word.includes(keyword))
    ).length;
  });

  return Object.entries(scores).reduce((a, b) => (a[1] > b[1] ? a : b))[0];
};

const extractEntities = (text) => {
  const tokenizer = new natural.WordTokenizer();
  const words = tokenizer.tokenize(text);

  // Simple named entity recognition (can be improved with more sophisticated NLP)
  const states = ["delhi", "mumbai", "kerala", "gujarat", "punjab"];
  const foundStates = states.filter((state) =>
    text.toLowerCase().includes(state)
  );

  // Extract potential person names (words starting with capital letters)
  const persons = words.filter(
    (word) => /^[A-Z][a-z]+$/.test(word) && word.length > 2
  );

  return {
    states: foundStates,
    people: [...new Set(persons)],
  };
};

const scrapeArticle = async (source) => {
  try {
    console.log(`Fetching from ${source.name} RSS feed`);
    const response = await axios.get(source.url, {
      timeout: 5000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)",
        Accept: "application/xml, application/rss+xml, text/xml",
      },
    });

    const $ = cheerio.load(response.data, { xmlMode: true });
    const articles = [];

    $("item")
      .slice(0, 3)
      .each((i, element) => {
        const title = $(element).find("title").text().trim();
        const description = $(element).find("description").text().trim();
        const pubDate = $(element).find("pubDate").text().trim();
        const link = $(element).find("link").text().trim();

        if (title) {
          const article = {
            source: source.name,
            title: title,
            summary: description || title,
            topic: categorizeArticle(title + " " + description),
            sentiment: analyzer
              .getSentiment((title + " " + description).split(" "))
              .toFixed(2),
            entities: extractEntities(title + " " + description),
            timestamp: new Date(pubDate).toISOString(),
            url: link,
          };
          articles.push(article);
        }
      });

    return articles;
  } catch (error) {
    console.error(`Error fetching ${source.name} RSS:`, error.message);
    return [];
  }
};

const updateNews = async () => {
  console.log("Starting news update...");
  const allArticles = [];

  // Process sources in parallel to speed up fetching
  const promises = sources.map((source) => scrapeArticle(source));
  const results = await Promise.allSettled(promises);

  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      allArticles.push(...result.value);
      console.log(
        `Successfully fetched ${result.value.length} articles from ${sources[index].name}`
      );
    } else {
      console.error(
        `Failed to fetch from ${sources[index].name}:`,
        result.reason
      );
    }
  });

  if (allArticles.length > 0) {
  newsCache = allArticles;
  console.log(`Update complete. Total articles: ${allArticles.length}`);
  }
};

const setupNewsScraping = () => {
  console.log("Setting up news scraping...");
  // Update news immediately on startup
  updateNews()
    .then(() => {
      console.log("Initial scraping completed");
    })
    .catch((err) => {
      console.error("Error in initial scraping:", err);
    });

  // Schedule updates every 30 minutes
  cron.schedule("*/30 * * * *", updateNews);
  console.log("Scheduled periodic updates");
};

const getNews = () => {
  console.log("getNews called. Current cache size:", newsCache.length);
  if (newsCache.length === 0) {
    console.log("Cache is empty, scraping may not have completed yet");
    // Instead of returning test articles, let's wait for real data
    return {
      message: "News is being fetched, please try again in a few seconds",
    };
  }
  return newsCache;
};

module.exports = {
  setupNewsScraping,
  getNews,
};
