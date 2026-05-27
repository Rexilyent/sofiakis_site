/*
=================================================
Build News Index Script
-------------------------------------------------
This script generates a JSON index of news articles by reading HTML
files in the news directory and extracting metadata from meta tags.
It is intended to be run as part of the build process to create an
up-to-date index for the news section of the website.
=================================================
Requirements:
- Node.js installed on your machine

=================================================
Usage:
	node build-news-index.js

=================================================
*/

import fs from "fs";
import path from "path";

/*
  Configuration
*/

const NEWS_DIR = path.resolve("./pages/public/news");
const OUTPUT_FILE = path.join(NEWS_DIR, "articles.json");

/*
  Helper function to extract meta tags
*/

function extractMeta(html, name) {
  const regex = new RegExp(
    `<meta\\s+name=["']news:${name}["']\\s+content=["']([^"']+)["']`,
    "i"
  );

  const match = html.match(regex);

  return match ? match[1].trim() : null;
}

/*
  Read all files in the news directory
*/

const files = fs
  .readdirSync(NEWS_DIR)
  .filter((file) => file.endsWith(".html") && file !== "index.html");

/*
  Build article list
*/

const articles = [];

for (const file of files) {
  const fullPath = path.join(NEWS_DIR, file);
  const html = fs.readFileSync(fullPath, "utf8");

  const slug = file.replace(".html", "");

  const title = extractMeta(html, "title");
  const date = extractMeta(html, "date");
  const summary = extractMeta(html, "summary");
  const category = extractMeta(html, "category");
  const featured = extractMeta(html, "featured");
  const image = extractMeta(html, "image");
  const author = extractMeta(html, "author");

  // Skip invalid articles
  if (!title || !date) {
    console.warn(`Skipping ${file} (missing required metadata)`);
    continue;
  }

  articles.push({
    slug,
    title,
    date,
    summary: summary || "",
    category: category || "",
    featured: featured === "true",
    image: image || "",
    author: author || ""
  });
}

/*
  Sort newest first
*/

articles.sort((a, b) => new Date(b.date) - new Date(a.date));

/*
  Write output file
*/

fs.writeFileSync(
  OUTPUT_FILE,
  JSON.stringify(articles, null, 2),
  "utf8"
);

console.log(`✔ Generated articles.json with ${articles.length} articles`);