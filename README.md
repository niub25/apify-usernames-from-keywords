# Instagram Keyword Username Discovery

Apify actor for discovering Instagram profile usernames from keyword search.

It is built for keywords such as `HOKA`, `Eliud Kipchoge`, `running shoes`, or `marathon coach`, where relevant accounts may appear in profile search results or in web-indexed Instagram profile/post/reel snippets.

## What It Does

- Searches Instagram's own profile search for each keyword.
- Searches web-indexed Instagram profile/post/reel pages for keyword mentions.
- Extracts usernames from profile URLs, `@username` mentions, and result snippets.
- Optionally expands into Instagram hashtag discovery, disabled by default.
- Pushes each username to the dataset immediately so already-collected data survives later failures.
- Saves checkpoint state in the key-value store under `DISCOVERY_STATE`.

## Output

Each dataset item contains:

```json
{
  "username": "example",
  "profileUrl": "https://www.instagram.com/example/",
  "fullName": "",
  "isVerified": false,
  "isPrivate": false,
  "sourceKeyword": "hoka",
  "sourceHashtag": "",
  "sourceType": "web_search_profile_url",
  "sourceUrl": "https://html.duckduckgo.com/html/?q=...",
  "scrapedAt": "2026-05-20T00:00:00.000Z"
}
```

## Recommended Input

```json
{
  "keywords": ["HOKA", "Eliud Kipchoge", "running shoes", "marathon coach", "trail running"],
  "maxResults": 30000,
  "maxKeywords": 500,
  "useWebSearch": true,
  "maxWebSearchResultsPerKeyword": 100,
  "useHashtagDiscovery": false,
  "requestDelayMs": 700
}
```

Add `sessionId`, `csrfToken`, and residential proxy settings in Apify input.

## Instagram Cookies

Provide a fresh Instagram `sessionid` cookie. `csrftoken` is optional but recommended.

To get them:

1. Log in to Instagram in Chrome.
2. Open DevTools.
3. Go to Application -> Cookies -> `https://www.instagram.com`.
4. Copy `sessionid` and `csrftoken`.

Treat these values like passwords.

## Notes

Instagram does not expose a reliable public API to search all captions/reels by arbitrary keyword. This actor broadens keyword coverage by combining Instagram account search with web-indexed Instagram profile/post/reel snippets.

Scraping Instagram may violate Instagram's Terms of Service. Use responsibly and comply with applicable laws.
