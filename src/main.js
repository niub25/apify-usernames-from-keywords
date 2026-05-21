import { Actor } from 'apify';
import { chromium } from 'playwright';
import { Dataset } from 'crawlee';

await Actor.init();

// ─── Input ────────────────────────────────────────────────────────────────────

const input = await Actor.getInput();
const {
    keywords: seedKeywords = [
        'running coach',
        'marathon runner',
        'trail running',
        'ultramarathon',
        'running tips',
        'half marathon training',
        'road running',
    ],
    maxKeywords        = 100,   // Max unique keywords/hashtag-names to search (Phase A)
    maxHashtags        = 50,    // Max hashtag feeds to paginate (Phase B)
    maxPagesPerHashtag = 10,    // Pages per hashtag in Phase B (each ≈ 12–24 users)
    expandViaHashtags  = true,  // Also scrape hashtag feeds discovered in Phase A
    sessionId,
    csrfToken,
    proxyConfiguration,
} = input;

if (!sessionId) {
    console.log('ERROR: sessionId is required. See INPUT_SCHEMA for how to get it.');
    await Actor.exit();
}

const proxyConfig = await Actor.createProxyConfiguration(
    proxyConfiguration ?? { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] }
);

// ─── Restore state after server migration ─────────────────────────────────────

const savedState = await Actor.getValue('STATE') ?? {};

const seenUsers    = new Set(savedState.seenUsers    ?? []);
const seenKeywords = new Set(savedState.seenKeywords ?? []);
const seenHashtags = new Set(savedState.seenHashtags ?? []);

// Phase A queue — normalised keyword strings to search
const keywordQueue = savedState.keywordQueue
    ?? [...new Set(
        seedKeywords
            .map(k => k.toLowerCase().trim())
            .filter(Boolean)
    )];

// Phase B queue — hashtag names discovered via keyword search results
const hashtagQueue = savedState.hashtagQueue ?? [];

console.log([
    `Restored state:`,
    `  ${seenUsers.size} users seen`,
    `  ${seenKeywords.size} keywords done, ${keywordQueue.length} in queue`,
    `  ${seenHashtags.size} hashtags done, ${hashtagQueue.length} in queue`,
].join('\n'));

// ─── Persist state on actor migration ────────────────────────────────────────

Actor.on('migrating', async () => {
    await Actor.setValue('STATE', {
        seenUsers:    [...seenUsers],
        seenKeywords: [...seenKeywords],
        seenHashtags: [...seenHashtags],
        keywordQueue,
        hashtagQueue,
    });
    console.log(
        `[MIGRATION] State saved — ${seenUsers.size} users | ` +
        `${seenKeywords.size} keywords | ${seenHashtags.size} hashtags`
    );
});

// ─── Launch browser ───────────────────────────────────────────────────────────

console.log('\nLaunching browser...');
const proxyUrl  = await proxyConfig.newUrl('ig_browser');
const proxyHost = proxyUrl ? new URL(proxyUrl) : null;

const browser = await chromium.launch({
    headless: true,
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
    ],
    proxy: proxyHost
        ? {
              server:   `${proxyHost.protocol}//${proxyHost.host}`,
              username: proxyHost.username ? decodeURIComponent(proxyHost.username) : undefined,
              password: proxyHost.password ? decodeURIComponent(proxyHost.password) : undefined,
          }
        : undefined,
});

const context = await browser.newContext({
    userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
        'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 },
});

// Inject Instagram session cookies
await context.addCookies([
    {
        name: 'sessionid', value: sessionId,
        domain: '.instagram.com', path: '/', httpOnly: true, secure: true,
    },
    ...(csrfToken
        ? [{ name: 'csrftoken', value: csrfToken, domain: '.instagram.com', path: '/', secure: true }]
        : []),
]);

const igPage = await context.newPage();

console.log('Navigating to Instagram to warm up session...');
await igPage.goto('https://www.instagram.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
}).catch(e => console.log(`Nav warning: ${e.message}`));

// ─── Core API fetch helper (runs inside browser context — uses session cookies) ─

async function igFetch(url) {
    try {
        const result = await igPage.evaluate(async (u) => {
            try {
                const r = await fetch(u, {
                    headers: {
                        'X-IG-App-ID':       '936619743392459',
                        'X-ASBD-ID':         '129477',
                        'Accept':            '*/*',
                        'X-Requested-With':  'XMLHttpRequest',
                    },
                    credentials: 'include',
                });
                if (!r.ok) return { error: r.status };
                return { data: await r.json() };
            } catch (e) {
                return { error: e.message };
            }
        }, url);
        return result?.data ?? null;
    } catch {
        return null;
    }
}

// ─── Phase A helpers: keyword search ─────────────────────────────────────────

/**
 * Searches Instagram for a keyword.
 * Returns discovered usernames + hashtag names.
 *
 * Uses two endpoints:
 *   1. Blended search — returns users + hashtags + places
 *   2. User-only search — sometimes surfaces different accounts
 */
async function searchKeyword(keyword) {
    const users    = new Set();
    const hashtags = new Set();

    // 1️⃣  Blended search (users + hashtags + places)
    const blended = await igFetch(
        `https://www.instagram.com/web/search/topsearch/` +
        `?query=${encodeURIComponent(keyword)}&context=blended&rank_token=&include_reel=true&count=30`
    );
    if (blended) {
        for (const u of (blended.users ?? [])) {
            const name = u?.user?.username;
            if (name) users.add(name);
        }
        for (const h of (blended.hashtags ?? [])) {
            const tag = h?.hashtag?.name;
            if (tag) hashtags.add(tag.toLowerCase().trim());
        }
    }

    // 2️⃣  User-only search (extra coverage)
    const userOnly = await igFetch(
        `https://www.instagram.com/web/search/topsearch/` +
        `?query=${encodeURIComponent(keyword)}&context=user&rank_token=&include_reel=true&count=30`
    );
    if (userOnly) {
        for (const u of (userOnly.users ?? [])) {
            const name = u?.user?.username;
            if (name) users.add(name);
        }
    }

    return { users: [...users], hashtags: [...hashtags] };
}

// ─── Phase B helpers: hashtag feed pagination (identical to Phase 1 actor) ────

/**
 * Fetches one page of posts for a given hashtag.
 * Tries mobile feed API first, falls back to web API.
 */
async function fetchHashtagPage(tag, maxId) {
    // Mobile feed API — supports deep pagination
    let mobileUrl =
        `https://i.instagram.com/api/v1/feed/tag/` +
        `?tag_name=${encodeURIComponent(tag)}&rank_token=&ranked_content=true`;
    if (maxId) mobileUrl += `&max_id=${encodeURIComponent(maxId)}`;

    const mobile = await igFetch(mobileUrl);
    if (mobile) {
        return {
            usernames:     (mobile.items ?? [])
                               .map(i => i?.user?.username || i?.owner?.username)
                               .filter(Boolean),
            nextMaxId:     mobile.next_max_id ?? null,
            moreAvailable: mobile.more_available ?? false,
            source:        'mobile',
        };
    }

    // Web API fallback
    let webUrl = `https://www.instagram.com/api/v1/tags/web_info/?tag_name=${encodeURIComponent(tag)}`;
    if (maxId) webUrl += `&max_id=${encodeURIComponent(maxId)}`;

    const web = await igFetch(webUrl);
    if (web) {
        const usernames = [];
        for (const key of ['recent', 'top']) {
            for (const section of (web?.data?.[key]?.sections ?? [])) {
                const medias = [
                    ...(section?.layout_content?.medias    ?? []),
                    ...(section?.layout_content?.fill_media ?? []),
                ];
                for (const m of medias) {
                    const u = (m?.media?.user || m?.media?.owner)?.username;
                    if (u) usernames.push(u);
                }
            }
        }
        return {
            usernames,
            nextMaxId:     web?.data?.recent?.next_max_id ?? null,
            moreAvailable: !!web?.data?.recent?.next_max_id,
            source:        'web',
        };
    }

    return null;
}

/**
 * Discovers related hashtags for a given tag.
 * Used in Phase B to grow the hashtag queue organically.
 */
async function discoverRelatedHashtags(tag) {
    const found = new Set();

    const related = await igFetch(
        `https://www.instagram.com/api/v1/tags/${encodeURIComponent(tag)}/related/`
    );
    for (const r of (related?.related_tags ?? [])) {
        if (r?.name) found.add(r.name.toLowerCase().trim());
    }

    const search = await igFetch(
        `https://www.instagram.com/api/v1/tags/search/?q=${encodeURIComponent(tag)}&count=15`
    );
    for (const r of (search?.results ?? [])) {
        if (r?.name) found.add(r.name.toLowerCase().trim());
    }

    return [...found];
}

// ─── Save state helper ────────────────────────────────────────────────────────

async function saveState() {
    await Actor.setValue('STATE', {
        seenUsers:    [...seenUsers],
        seenKeywords: [...seenKeywords],
        seenHashtags: [...seenHashtags],
        keywordQueue,
        hashtagQueue,
    });
}

// ─── API smoke test ───────────────────────────────────────────────────────────

console.log('\nTesting API connectivity...');
const testResult = await searchKeyword('running');
if (!testResult || (testResult.users.length === 0 && testResult.hashtags.length === 0)) {
    console.log(
        'ERROR: API test failed — Instagram returned no results.\n' +
        'ACTION: Get a fresh sessionid + csrftoken from Chrome DevTools and retry.'
    );
    await browser.close();
    await Actor.exit();
}
console.log(
    `API OK — test search found ${testResult.users.length} users, ` +
    `${testResult.hashtags.length} hashtags`
);

// ─────────────────────────────────────────────────────────────────────────────
// PHASE A — Keyword search
//   For each keyword in the queue:
//     1. Run blended + user-only search
//     2. Save discovered usernames to dataset
//     3. Push discovered hashtag names into:
//          a) keywordQueue — so we also search the hashtag name as a keyword
//          b) hashtagQueue — so Phase B paginates the hashtag feed
// ─────────────────────────────────────────────────────────────────────────────

console.log([
    `\n${'─'.repeat(60)}`,
    `PHASE A — Keyword search`,
    `  Seed keywords      : ${seedKeywords.length}`,
    `  Max keywords       : ${maxKeywords}`,
    `  Expand via hashtags: ${expandViaHashtags}`,
    `  Already done       : ${seenKeywords.size} keywords, ${seenUsers.size} users`,
    `${'─'.repeat(60)}`,
].join('\n'));

while (keywordQueue.length > 0 && seenKeywords.size < maxKeywords) {
    const keyword = keywordQueue.shift();
    if (!keyword || seenKeywords.has(keyword)) continue;
    seenKeywords.add(keyword);

    console.log(`\n[KW ${seenKeywords.size}/${maxKeywords}] "${keyword}"`);

    const { users, hashtags } = await searchKeyword(keyword);

    // ── Save new usernames ─────────────────────────────────────────────────
    let savedUsers = 0;
    for (const username of users) {
        if (seenUsers.has(username)) continue;
        seenUsers.add(username);
        await Dataset.pushData({
            username,
            discoveredFrom: keyword,
            discoveryType:  'keyword_search',
            scrapedAt:      new Date().toISOString(),
        });
        savedUsers++;
    }
    console.log(
        `  Users  : ${users.length} found, +${savedUsers} new` +
        ` (total: ${seenUsers.size})`
    );

    // ── Enqueue discovered hashtags ────────────────────────────────────────
    let addedToKeywords = 0;
    let addedToHashtags = 0;

    for (const tag of hashtags) {
        // Add as keyword so we search for it too (e.g. "runningcoach" → search "runningcoach")
        if (
            !seenKeywords.has(tag) &&
            !keywordQueue.includes(tag) &&
            seenKeywords.size + keywordQueue.length < maxKeywords * 2
        ) {
            keywordQueue.push(tag);
            addedToKeywords++;
        }

        // Add to hashtag feed queue for Phase B
        if (expandViaHashtags && !seenHashtags.has(tag) && !hashtagQueue.includes(tag)) {
            hashtagQueue.push(tag);
            addedToHashtags++;
        }
    }

    console.log(
        `  Hashtags: ${hashtags.length} found` +
        ` | +${addedToKeywords} → keyword queue (${keywordQueue.length})` +
        ` | +${addedToHashtags} → hashtag queue (${hashtagQueue.length})`
    );

    // Checkpoint every 10 keywords
    if (seenKeywords.size % 10 === 0) {
        await saveState();
        console.log(`  [checkpoint] State saved`);
    }

    await new Promise(r => setTimeout(r, 400));
}

console.log([
    `\nPhase A complete`,
    `  Keywords processed : ${seenKeywords.size}`,
    `  Users found        : ${seenUsers.size}`,
    `  Hashtags queued    : ${hashtagQueue.length}`,
].join('\n'));

// ─────────────────────────────────────────────────────────────────────────────
// PHASE B — Hashtag feed expansion
//   For each hashtag discovered in Phase A:
//     1. Discover related hashtags → add to queue (organic growth, same as Phase 1)
//     2. Paginate the hashtag feed to collect more usernames
//   This mirrors the Phase 1 (hashtag scraper) logic exactly.
// ─────────────────────────────────────────────────────────────────────────────

if (expandViaHashtags && hashtagQueue.length > 0) {
    console.log([
        `\n${'─'.repeat(60)}`,
        `PHASE B — Hashtag feed expansion`,
        `  Hashtags queued    : ${hashtagQueue.length}`,
        `  Max hashtags       : ${maxHashtags}`,
        `  Pages per hashtag  : ${maxPagesPerHashtag}`,
        `  Already done       : ${seenHashtags.size} hashtags`,
        `${'─'.repeat(60)}`,
    ].join('\n'));

    while (hashtagQueue.length > 0 && seenHashtags.size < maxHashtags) {
        const tag = hashtagQueue.shift();
        if (!tag || seenHashtags.has(tag)) continue;
        seenHashtags.add(tag);

        console.log(`\n[HT ${seenHashtags.size}/${maxHashtags}] #${tag}`);

        // Discover related hashtags → grow the queue (same as Phase 1 actor)
        const related = await discoverRelatedHashtags(tag);
        let addedRelated = 0;
        for (const r of related) {
            if (!seenHashtags.has(r) && !hashtagQueue.includes(r)) {
                hashtagQueue.push(r);
                addedRelated++;
            }
        }
        if (addedRelated > 0) {
            console.log(`  +${addedRelated} related tags → hashtag queue: ${hashtagQueue.length}`);
        }

        // Paginate hashtag feed
        let pageNum       = 0;
        let nextMaxId     = '';
        let moreAvailable = true;
        let tagTotal      = 0;
        const newUsersThisTag = [];

        while (pageNum < maxPagesPerHashtag && moreAvailable) {
            pageNum++;
            const result = await fetchHashtagPage(tag, nextMaxId);

            if (!result) {
                console.log(`  p${pageNum}: failed — skipping remaining pages`);
                break;
            }

            let newCount = 0;
            for (const u of result.usernames) {
                if (!u || seenUsers.has(u)) continue;
                seenUsers.add(u);
                newUsersThisTag.push(u);
                newCount++;
                tagTotal++;
            }

            console.log(
                `  p${pageNum} [${result.source}]:` +
                ` +${newCount} new | tag total: ${tagTotal}` +
                ` | all time: ${seenUsers.size}` +
                ` | next: ${result.nextMaxId ? '✅' : '❌'}`
            );

            if (!result.nextMaxId || !result.moreAvailable || newCount === 0) {
                moreAvailable = false;
                break;
            }
            nextMaxId = result.nextMaxId;
            await new Promise(r => setTimeout(r, 500));
        }

        // Batch-save new usernames from this hashtag
        for (const username of newUsersThisTag) {
            await Dataset.pushData({
                username,
                discoveredFrom: tag,
                discoveryType:  'hashtag_expansion',
                scrapedAt:      new Date().toISOString(),
            });
        }
        if (newUsersThisTag.length > 0) {
            console.log(`  Saved ${newUsersThisTag.length} new usernames`);
        }

        // Checkpoint every 5 hashtags
        if (seenHashtags.size % 5 === 0) {
            await saveState();
            console.log(`  [checkpoint] State saved`);
        }

        await new Promise(r => setTimeout(r, 400));
    }

    console.log([
        `\nPhase B complete`,
        `  Hashtags processed : ${seenHashtags.size}`,
        `  Users found        : ${seenUsers.size}`,
    ].join('\n'));
}

// ─── Teardown ─────────────────────────────────────────────────────────────────

await browser.close();

await saveState();

console.log([
    `\n${'═'.repeat(60)}`,
    `DONE`,
    `  Keywords processed : ${seenKeywords.size}`,
    `  Hashtags expanded  : ${seenHashtags.size}`,
    `  Unique usernames   : ${seenUsers.size}`,
    `${'═'.repeat(60)}`,
].join('\n'));

await Actor.exit();
