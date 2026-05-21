# 🔍 Instagram Keyword Scraper — Apify Actor

Discovers Instagram **running creator usernames** by searching keywords,
auto-expanding into related hashtags, and (optionally) paginating those
hashtag feeds for deeper coverage.

Works as a **standalone** actor or as a complement to the
**Instagram Hashtag Scraper** (Phase 1) to maximise username coverage.

---

## 🔄 How it works — Two-phase discovery

```
Seed keywords
     │
     ▼
┌─────────────────────────────────────────────┐
│  PHASE A — Keyword Search                   │
│                                             │
│  For each keyword in queue:                 │
│   ① Blended search  →  users + hashtags    │
│   ② User-only search → more users          │
│   ③ Save usernames to dataset               │
│   ④ Hashtags found → add to keyword queue  │
│      (e.g. "runningcoach" → search it too) │
│   ⑤ Hashtags found → add to hashtag queue │
└───────────────────────────┬─────────────────┘
                            │ (if expandViaHashtags = true)
                            ▼
┌─────────────────────────────────────────────┐
│  PHASE B — Hashtag Feed Expansion           │
│  (same engine as the Hashtag Scraper)       │
│                                             │
│  For each discovered hashtag:               │
│   ① Find related hashtags → grow queue     │
│   ② Paginate feed (mobile API → web API)   │
│   ③ Save usernames to dataset               │
└─────────────────────────────────────────────┘
```

---

## 📦 Output fields (per username record)

| Field             | Type   | Description                                      |
|-------------------|--------|--------------------------------------------------|
| `username`        | String | Instagram handle                                 |
| `discoveredFrom`  | String | Keyword or hashtag that surfaced this username   |
| `discoveryType`   | String | `"keyword_search"` or `"hashtag_expansion"`      |
| `scrapedAt`       | String | ISO timestamp                                    |

> **This is a username-only output.** Feed the usernames into the
> **Phase 2 Profile Enricher** actor to get follower counts, bios,
> emails, etc.

---

## ⚙️ Input parameters

### `keywords` — Array of strings
Seed search terms. Use natural phrases, **not** hashtag format.

**Good examples:**
```
running coach
marathon runner
trail running
ultramarathon
half marathon training
```

The actor auto-discovers related hashtags from search results and searches
those too, so a small seed list expands significantly.

**Default:** 7 running-related phrases

---

### `maxKeywords` — Integer (default: `100`)
Total keywords to process in Phase A (seeds + auto-discovered hashtag names).
Each search returns ~10–30 usernames.

| Value | Approx. usernames from Phase A |
|-------|-------------------------------|
| 50    | ~750 – 1,500                  |
| 100   | ~1,500 – 3,000                |
| 200   | ~3,000 – 6,000                |

---

### `expandViaHashtags` — Boolean (default: `true`)
When enabled, Phase B runs after Phase A and paginates the hashtag feeds
discovered during keyword search. This is the same engine as the Hashtag
Scraper and produces far more usernames.

---

### `maxHashtags` — Integer (default: `50`)
Max hashtag feeds to paginate in Phase B.

---

### `maxPagesPerHashtag` — Integer (default: `10`)
Pages per hashtag in Phase B. Each page ≈ 12–24 usernames.
`10 pages × 50 hashtags = ~6,000–12,000 additional usernames`.

---

### `sessionId` *(required)* — Secret string
Your Instagram `sessionid` cookie.

**How to get it:**
1. Log in to Instagram in Chrome
2. Open DevTools → **Application** → **Cookies** → `https://www.instagram.com`
3. Copy the value of the `sessionid` cookie

Or paste this in the Chrome DevTools console:
```js
document.cookie.split(';').find(c=>c.trim().startsWith('sessionid')).split('=')[1]
```

⚠️ Treat this like a password. Use Apify's **secret** field type.

---

### `csrfToken` *(recommended)* — Secret string
Your Instagram `csrftoken` cookie. Get it the same way as `sessionId`.

```js
document.cookie.split(';').find(c=>c.trim().startsWith('csrftoken')).split('=')[1]
```

---

### `proxyConfiguration` — Proxy object
Defaults to **Apify Residential** proxies, which are strongly recommended
for Instagram. Without residential proxies expect aggressive 429 blocking.

---

## 🚀 Deployment

### Apify Console (easiest)
1. Console → **Actors** → **Create new** → **Link Git repository**
2. Point to this repo → **Build**

### Apify CLI
```bash
npm install -g apify-cli
apify login
apify push
```

---

## 💡 Recommended usage — combine with Hashtag Scraper

Run **both** actors in parallel for maximum coverage:

| Actor              | Discovery method          | Usernames per run (typical) |
|--------------------|---------------------------|------------------------------|
| Hashtag Scraper    | Hashtag feeds (paginated) | 10,000 – 100,000+            |
| **Keyword Scraper**| Search API + feed expand  | 5,000 – 50,000+              |

Merge the two datasets and deduplicate by `username` before running
the Profile Enricher.

---

## ⚠️ Important notes

1. **Session freshness** — `sessionId` typically lasts 1–4 weeks. If the
   actor returns 0 results or fails the API test, refresh it.
2. **Proxy requirement** — Residential proxies are essential. Datacenter
   proxies will be blocked quickly.
3. **Account risk** — Use a dedicated scraping account, not your personal one.
4. **Rate limits** — The actor includes built-in delays. Do not remove them.
5. **Server migration** — State is checkpointed every 10 keywords / 5 hashtags.
   If Apify migrates the actor mid-run, it resumes exactly where it left off.
6. **ToS** — Scraping Instagram may violate their Terms of Service. Use for
   legitimate business purposes only.
