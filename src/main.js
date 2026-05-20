import { Actor } from 'apify';
import { Dataset, log } from 'crawlee';
import { chromium } from 'playwright';
import { gotScraping } from 'got-scraping';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const STATE_KEY = 'DISCOVERY_STATE';
const RESERVED_INSTAGRAM_PATHS = new Set([
    'p', 'reel', 'reels', 'tv', 'stories', 'explore', 'accounts', 'direct',
    'api', 'graphql', 'web', 'about', 'developer', 'privacy', 'terms',
]);

function cleanText(value) {
    return String(value ?? '').toLowerCase().trim();
}

function normalizeUsername(username) {
    const cleaned = cleanText(username).replace(/^@/, '');
    if (!/^[a-z0-9._]{1,30}$/.test(cleaned)) return '';
    if (RESERVED_INSTAGRAM_PATHS.has(cleaned)) return '';
    return cleaned;
}

function normalizeHashtag(tag) {
    const cleaned = cleanText(tag).replace(/^#/, '');
    return /^[a-z0-9][a-z0-9._]{1,49}$/.test(cleaned) ? cleaned : '';
}

function normalizeKeyword(keyword) {
    return cleanText(keyword)
        .replace(/[#@]/g, ' ')
        .replace(/[^\p{L}\p{N}._\s-]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function uniq(values) {
    return [...new Set(values.filter(Boolean))];
}

function keywordVariants(keyword) {
    const normalized = normalizeKeyword(keyword);
    if (!normalized) return [];

    const compact = normalizeKeyword(normalized.replace(/\s+/g, ''));
    const tokens = normalized.split(/\s+/).filter(t => t.length >= 3);
    const variants = [normalized, compact, ...tokens];

    for (const token of tokens) {
        variants.push(`${token} running`);
        variants.push(`${token} runner`);
        variants.push(`${token} marathon`);
    }

    return uniq(variants).slice(0, 20);
}

function extractUsernameRecordsFromSearch(data, sourceKeyword) {
    const records = [];
    for (const item of (data?.users ?? [])) {
        const user = item?.user ?? item;
        const username = normalizeUsername(user?.username);
        if (!username) continue;
        records.push({
            username,
            fullName: user?.full_name ?? '',
            isVerified: user?.is_verified ?? false,
            isPrivate: user?.is_private ?? false,
            sourceKeyword,
            sourceType: 'search_user',
        });
    }
    return records;
}

function decodeHtmlEntities(text) {
    return String(text ?? '')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}

function safeDecodeURIComponent(value) {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function extractUsernameRecordsFromWebText(text, sourceKeyword, sourceUrl = '') {
    const decoded = safeDecodeURIComponent(decodeHtmlEntities(text));
    const records = new Map();
    const add = (username, sourceType) => {
        const normalized = normalizeUsername(username);
        if (!normalized || records.has(normalized)) return;
        records.set(normalized, {
            username: normalized,
            sourceKeyword,
            sourceUrl,
            sourceType,
        });
    };

    for (const match of decoded.matchAll(/instagram\.com\/([a-zA-Z0-9._]{1,30})(?:[/?#"'&\s<]|$)/g)) {
        add(match[1], 'web_search_profile_url');
    }

    for (const match of decoded.matchAll(/@([a-zA-Z0-9._]{1,30})/g)) {
        add(match[1], 'web_search_mention');
    }

    for (const match of decoded.matchAll(/(?:instagram\s+(?:photo|video|reel)\s+by|posted\s+by|by)\s+@?([a-zA-Z0-9._]{1,30})/gi)) {
        add(match[1], 'web_search_snippet');
    }

    return [...records.values()];
}

function extractHashtagsFromSearch(data) {
    const tags = [];
    for (const item of (data?.hashtags ?? [])) {
        const tag = normalizeHashtag(item?.hashtag?.name ?? item?.name);
        if (tag) tags.push(tag);
    }
    return uniq(tags);
}

function extractUsernamesFromTagData(data) {
    const usernames = [];
    const add = username => {
        const normalized = normalizeUsername(username);
        if (normalized) usernames.push(normalized);
    };

    for (const item of (data?.items ?? [])) {
        add(item?.user?.username || item?.owner?.username);
    }

    for (const item of (data?.ranked_items ?? [])) {
        add(item?.user?.username || item?.owner?.username);
    }

    for (const key of ['recent', 'top']) {
        for (const section of (data?.data?.[key]?.sections ?? [])) {
            for (const media of [
                ...(section?.layout_content?.medias ?? []),
                ...(section?.layout_content?.fill_media ?? []),
            ]) {
                add(media?.media?.user?.username || media?.media?.owner?.username);
            }
        }
    }

    return uniq(usernames);
}

function getNextMaxId(data) {
    return data?.next_max_id
        ?? data?.nextMaxId
        ?? data?.data?.recent?.next_max_id
        ?? null;
}

function hasMorePages(data, nextMaxId) {
    if (typeof data?.more_available === 'boolean') return data.more_available && !!nextMaxId;
    return !!nextMaxId;
}

await Actor.init();

const input = await Actor.getInput();
const {
    keywords: seedKeywords = ['hoka', 'eliud kipchoge', 'running shoes', 'marathon runner', 'trail running'],
    maxResults = 30000,
    maxKeywords = 500,
    maxHashtags = 3000,
    maxHashtagPages = 1,
    searchResultLimit = 50,
    useWebSearch = true,
    useHashtagDiscovery = false,
    maxWebSearchResultsPerKeyword = 100,
    relatedSearchCount = 50,
    requestDelayMs = 700,
    checkpointEvery = 100,
    sessionId,
    csrfToken,
    proxyConfiguration,
} = input;

if (!sessionId) {
    log.error('sessionId is required!');
    await Actor.exit();
}

const proxyConfig = await Actor.createProxyConfiguration(
    proxyConfiguration ?? { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] }
);

log.info('Launching browser...');
const proxyUrl = await proxyConfig.newUrl('ig_browser');
const webSearchProxyUrl = await proxyConfig.newUrl('web_search');
const proxyHost = proxyUrl ? new URL(proxyUrl) : null;

const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
    proxy: proxyHost ? {
        server: `${proxyHost.protocol}//${proxyHost.host}`,
        username: proxyHost.username ? decodeURIComponent(proxyHost.username) : undefined,
        password: proxyHost.password ? decodeURIComponent(proxyHost.password) : undefined,
    } : undefined,
});

const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 },
});

await context.addCookies([
    { name: 'sessionid', value: sessionId, domain: '.instagram.com', path: '/', httpOnly: true, secure: true },
    ...(csrfToken ? [{ name: 'csrftoken', value: csrfToken, domain: '.instagram.com', path: '/', secure: true }] : []),
]);

const igPage = await context.newPage();

log.info('Navigating to Instagram...');
await igPage.goto('https://www.instagram.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
}).catch(e => log.warning(`Nav warning: ${e.message}`));

async function igApiFetch(apiUrl, retryCount = 0) {
    try {
        const result = await igPage.evaluate(async (url) => {
            try {
                const r = await fetch(url, {
                    headers: {
                        'X-IG-App-ID': '936619743392459',
                        'X-ASBD-ID': '129477',
                        'X-IG-Capabilities': '3brTvw==',
                        'X-IG-Connection-Type': 'WiFi',
                        'Accept': '*/*',
                        'Accept-Language': 'en-US,en;q=0.9',
                        'X-Requested-With': 'XMLHttpRequest',
                    },
                    credentials: 'include',
                });
                return { status: r.status, data: r.ok ? await r.json() : null };
            } catch (e) {
                return { status: 0, error: e.message };
            }
        }, apiUrl);

        if (result?.status === 429) {
            const waitMs = Math.min(30000 * Math.pow(2, retryCount), 300000);
            log.warning(`Rate limited (429). Waiting ${waitMs / 1000}s before retry ${retryCount + 1}/5.`);
            await sleep(waitMs);
            if (retryCount < 5) return igApiFetch(apiUrl, retryCount + 1);
            return null;
        }

        if (result?.status === 401 || result?.status === 403) {
            log.warning(`Auth error (${result.status}). Session may have expired.`);
            return null;
        }

        if (result?.error || !result?.data) return null;
        return result.data;
    } catch (e) {
        log.warning(`igApiFetch error: ${e.message}`);
        return null;
    }
}

async function fetchSearchResults(keyword) {
    const encoded = encodeURIComponent(keyword);
    const urls = [
        `https://www.instagram.com/web/search/topsearch/?context=blended&query=${encoded}&rank_token=0.1&include_reel=false`,
        `https://www.instagram.com/api/v1/web/search/topsearch/?context=blended&query=${encoded}&rank_token=0.1&include_reel=false`,
    ];

    for (const url of urls) {
        const data = await igApiFetch(url);
        if (data) return data;
    }
    return null;
}

async function fetchWebSearchHtml(url) {
    try {
        const response = await gotScraping({
            url,
            proxyUrl: webSearchProxyUrl,
            timeout: { request: 30000 },
            throwHttpErrors: false,
            headers: {
                'Accept-Language': 'en-US,en;q=0.9',
            },
        });

        if (response.statusCode === 429 || response.statusCode === 403) {
            log.warning(`   web search blocked (${response.statusCode}) for ${new URL(url).hostname}`);
            return '';
        }

        if (response.statusCode < 200 || response.statusCode >= 300) return '';
        return response.body ?? '';
    } catch (e) {
        log.warning(`   web search request failed: ${e.message}`);
        return '';
    }
}

async function fetchWebSearchUsernameRecords(keyword) {
    if (!useWebSearch) return [];

    const queryTemplates = [
        `site:instagram.com "${keyword}"`,
        `site:instagram.com/p/ "${keyword}"`,
        `site:instagram.com/reel/ "${keyword}"`,
        `site:instagram.com "${keyword}" "running"`,
        `site:instagram.com "${keyword}" "marathon"`,
    ];

    const records = new Map();

    for (const query of queryTemplates) {
        const encoded = encodeURIComponent(query);
        const searchUrls = [
            `https://html.duckduckgo.com/html/?q=${encoded}`,
            `https://www.bing.com/search?q=${encoded}&count=50`,
        ];

        for (const searchUrl of searchUrls) {
            const html = await fetchWebSearchHtml(searchUrl);
            for (const record of extractUsernameRecordsFromWebText(html, keyword, searchUrl)) {
                if (!records.has(record.username)) records.set(record.username, record);
                if (records.size >= maxWebSearchResultsPerKeyword) break;
            }
            if (records.size >= maxWebSearchResultsPerKeyword) break;
            await sleep(Math.max(250, Math.floor(requestDelayMs / 2)));
        }

        if (records.size >= maxWebSearchResultsPerKeyword) break;
    }

    return [...records.values()];
}

async function fetchHashtagSearch(keyword) {
    const data = await igApiFetch(
        `https://www.instagram.com/api/v1/tags/search/?q=${encodeURIComponent(keyword)}&count=${relatedSearchCount}`
    );
    return uniq([
        ...extractHashtagsFromSearch(data ?? {}),
        ...(data?.results ?? []).map(result => normalizeHashtag(result?.name)),
    ]);
}

async function discoverRelatedHashtags(tag) {
    const discovered = new Set();
    const related = await igApiFetch(`https://www.instagram.com/api/v1/tags/${encodeURIComponent(tag)}/related/`);

    for (const item of (related?.related_tags ?? [])) {
        const hashtag = normalizeHashtag(item?.name);
        if (hashtag) discovered.add(hashtag);
    }

    for (const hashtag of await fetchHashtagSearch(tag)) {
        discovered.add(hashtag);
    }

    return [...discovered];
}

async function fetchHashtagPage(tag, maxId) {
    let mobileUrl = `https://i.instagram.com/api/v1/feed/tag/?tag_name=${encodeURIComponent(tag)}&rank_token=&ranked_content=true`;
    if (maxId) mobileUrl += `&max_id=${encodeURIComponent(maxId)}`;

    const mobileData = await igApiFetch(mobileUrl);
    if (mobileData) {
        const nextMaxId = getNextMaxId(mobileData);
        return {
            usernames: extractUsernamesFromTagData(mobileData),
            nextMaxId,
            moreAvailable: hasMorePages(mobileData, nextMaxId),
            source: 'hashtag_mobile',
        };
    }

    let webUrl = `https://www.instagram.com/api/v1/tags/web_info/?tag_name=${encodeURIComponent(tag)}`;
    if (maxId) webUrl += `&max_id=${encodeURIComponent(maxId)}`;

    const webData = await igApiFetch(webUrl);
    if (webData) {
        const nextMaxId = getNextMaxId(webData);
        return {
            usernames: extractUsernamesFromTagData(webData),
            nextMaxId,
            moreAvailable: hasMorePages(webData, nextMaxId),
            source: 'hashtag_web',
        };
    }

    return null;
}

const state = await Actor.getValue(STATE_KEY).catch(() => null) ?? {};
const seenUsers = new Set(state.seenUsers ?? []);
const processedKeywords = new Set(state.processedKeywords ?? []);
const processedHashtags = new Set(state.processedHashtags ?? []);
const keywordQueue = state.keywordQueue?.length
    ? state.keywordQueue
    : uniq(seedKeywords.flatMap(keywordVariants)).slice(0, maxKeywords);
const hashtagQueue = useHashtagDiscovery ? (state.hashtagQueue ?? []) : [];

let savedSinceCheckpoint = 0;

async function saveState() {
    await Actor.setValue(STATE_KEY, {
        seenUsers: [...seenUsers],
        processedKeywords: [...processedKeywords],
        processedHashtags: [...processedHashtags],
        keywordQueue,
        hashtagQueue,
        savedAt: new Date().toISOString(),
    });
}

async function pushUsername(record) {
    const username = normalizeUsername(record.username);
    if (!username || seenUsers.has(username) || seenUsers.size >= maxResults) return false;

    seenUsers.add(username);
    savedSinceCheckpoint++;

    await Dataset.pushData({
        username,
        profileUrl: `https://www.instagram.com/${username}/`,
        fullName: record.fullName ?? '',
        isVerified: record.isVerified ?? false,
        isPrivate: record.isPrivate ?? false,
        sourceKeyword: record.sourceKeyword ?? '',
        sourceHashtag: record.sourceHashtag ?? '',
        sourceType: record.sourceType,
        sourceUrl: record.sourceUrl ?? '',
        scrapedAt: new Date().toISOString(),
    });

    if (savedSinceCheckpoint >= checkpointEvery) {
        savedSinceCheckpoint = 0;
        await saveState().catch(e => log.warning(`Checkpoint failed: ${e.message}`));
    }

    return true;
}

function queueKeyword(keyword) {
    const normalized = normalizeKeyword(keyword);
    if (!normalized || processedKeywords.has(normalized) || keywordQueue.includes(normalized)) return false;
    if (processedKeywords.size + keywordQueue.length >= maxKeywords) return false;
    keywordQueue.push(normalized);
    return true;
}

function queueHashtag(hashtag) {
    if (!useHashtagDiscovery) return false;
    const normalized = normalizeHashtag(hashtag);
    if (!normalized || processedHashtags.has(normalized) || hashtagQueue.includes(normalized)) return false;
    if (processedHashtags.size + hashtagQueue.length >= maxHashtags) return false;
    hashtagQueue.push(normalized);
    return true;
}

log.info('\nInstagram Search Username Discovery');
log.info(`   Seed keywords  : ${seedKeywords.length}`);
log.info(`   Keyword limit  : ${maxKeywords}`);
log.info(`   Web search     : ${useWebSearch ? 'enabled' : 'disabled'}`);
log.info(`   Hashtags       : ${useHashtagDiscovery ? `enabled, limit ${maxHashtags}` : 'disabled'}`);
log.info(`   Max usernames  : ${maxResults}`);
log.info(`   Restored users : ${seenUsers.size}`);

try {
    while ((keywordQueue.length > 0 || hashtagQueue.length > 0) && seenUsers.size < maxResults) {
        while (keywordQueue.length > 0 && processedKeywords.size < maxKeywords && seenUsers.size < maxResults) {
            const keyword = keywordQueue.shift();
            if (!keyword || processedKeywords.has(keyword)) continue;
            processedKeywords.add(keyword);

            log.info(`\nKeyword [${processedKeywords.size}/${maxKeywords}]: "${keyword}"`);

            try {
                const searchData = await fetchSearchResults(keyword);
                const userRecords = extractUsernameRecordsFromSearch(searchData, keyword).slice(0, searchResultLimit);
                const webRecords = await fetchWebSearchUsernameRecords(keyword);
                let savedUsers = 0;

                for (const record of [...userRecords, ...webRecords]) {
                    if (await pushUsername(record)) savedUsers++;
                }

                let queuedTags = 0;
                if (useHashtagDiscovery) {
                    const hashtags = uniq([
                        ...extractHashtagsFromSearch(searchData ?? {}),
                        ...(await fetchHashtagSearch(keyword).catch(() => [])),
                    ]);
                    for (const tag of hashtags) {
                        if (queueHashtag(tag)) queuedTags++;
                    }
                }

                for (const variant of keywordVariants(keyword)) {
                    queueKeyword(variant);
                }

                log.info(`   saved users: ${savedUsers} | web candidates: ${webRecords.length} | queued hashtags: ${queuedTags} | total users: ${seenUsers.size}`);
            } catch (e) {
                log.warning(`   keyword failed: ${e.message}`);
            }

            await saveState().catch(e => log.warning(`State save failed: ${e.message}`));
            await sleep(requestDelayMs);
        }

        if (hashtagQueue.length === 0) break;

        const tag = hashtagQueue.shift();
        if (!tag || processedHashtags.has(tag)) continue;
        processedHashtags.add(tag);

        log.info(`\nHashtag [${processedHashtags.size}/${maxHashtags}]: #${tag}`);

        try {
            const related = await discoverRelatedHashtags(tag);
            let queuedRelated = 0;
            for (const relatedTag of related) {
                if (queueHashtag(relatedTag)) queuedRelated++;
            }

            let page = 0;
            let nextMaxId = '';
            let moreAvailable = true;
            let savedFromTag = 0;

            while (page < maxHashtagPages && moreAvailable && seenUsers.size < maxResults) {
                page++;
                const result = await fetchHashtagPage(tag, nextMaxId);
                if (!result) {
                    log.warning(`   page ${page}: no data`);
                    break;
                }

                let pageSaved = 0;
                for (const username of result.usernames) {
                    if (await pushUsername({
                        username,
                        sourceHashtag: tag,
                        sourceType: result.source,
                    })) {
                        pageSaved++;
                        savedFromTag++;
                    }
                    if (seenUsers.size >= maxResults) break;
                }

                log.info(`   page ${page} [${result.source}]: +${pageSaved} | tag total: ${savedFromTag} | all: ${seenUsers.size}`);

                if (!result.nextMaxId || !result.moreAvailable || pageSaved === 0) break;
                nextMaxId = result.nextMaxId;
                await sleep(requestDelayMs);
            }

            log.info(`   queued related hashtags: ${queuedRelated}`);
        } catch (e) {
            log.warning(`   hashtag failed: ${e.message}`);
        }

        await saveState().catch(e => log.warning(`State save failed: ${e.message}`));
        await sleep(requestDelayMs);
    }
} catch (e) {
    log.exception(e, 'Fatal loop error. Saving state before exit.');
    await saveState().catch(err => log.warning(`Final state save failed: ${err.message}`));
} finally {
    await browser.close().catch(() => {});
}

await saveState().catch(e => log.warning(`Final state save failed: ${e.message}`));

log.info('\nDone');
log.info(`   Keywords processed : ${processedKeywords.size}`);
log.info(`   Hashtags processed : ${processedHashtags.size}`);
log.info(`   Usernames saved    : ${seenUsers.size}`);

await Actor.setValue('SUMMARY', {
    keywordsProcessed: processedKeywords.size,
    hashtagsProcessed: processedHashtags.size,
    usernamesSaved: seenUsers.size,
});

await Actor.exit();
