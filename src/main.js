// France Travail Jobs Scraper - API-first with batched writes and reduced logging
import { Actor, log } from 'apify';
import { Dataset } from 'crawlee';
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';
import { load as cheerioLoad } from 'cheerio';

const BASE_URL = 'https://candidat.francetravail.fr';
const PAGE_SIZE = 20;
const SEARCH_RADIUS_KM = 10;
const DETAIL_CONCURRENCY = 8;
const PUSH_BATCH_SIZE = 25;
const OMIT_NULL_VALUES = true;
const OUTPUT_KEY_ORDER = [
    'offer_id',
    'job_title',
    'company',
    'location',
    'contract_type',
    'work_hours',
    'salary',
    'date_posted',
    'description_text',
    'description_html',
    'experience',
    'formation',
    'skills',
    'languages',
    'qualification',
    'sector',
    'latitude',
    'longitude',
    'url',
];

await Actor.init();

function normalizeWhitespace(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeLabel(value) {
    return normalizeWhitespace(value)
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[:]/g, '');
}

function stripHtmlToText(html) {
    if (!html) return '';
    const $ = cheerioLoad(`<div>${html}</div>`);
    return normalizeWhitespace($.text());
}

function firstNonEmpty(...values) {
    for (const value of values) {
        if (value === null || value === undefined) continue;
        if (typeof value === 'string') {
            const normalized = normalizeWhitespace(value);
            if (normalized) return normalized;
            continue;
        }
        if (Array.isArray(value)) {
            if (value.length > 0) return value;
            continue;
        }
        return value;
    }
    return undefined;
}

function parseContractText(contractValue) {
    const text = normalizeWhitespace(contractValue);
    if (!text) return {};

    const parts = text.split(',').map((part) => normalizeWhitespace(part)).filter(Boolean);
    return {
        contract_type: parts[0],
        work_hours: parts[1],
    };
}

function mergeCookies(existing, incoming) {
    if (!incoming) return existing;
    const map = new Map();

    for (const part of `${existing}; ${incoming}`.split(';')) {
        const trimmed = part.trim();
        if (!trimmed || !trimmed.includes('=')) continue;
        const name = trimmed.split('=')[0].trim();
        map.set(name, trimmed);
    }

    return [...map.values()].join('; ');
}

function sanitizeRecord(record) {
    if (record === null || record === undefined) return undefined;

    if (Array.isArray(record)) {
        const cleanedArray = record
            .map((item) => sanitizeRecord(item))
            .filter((item) => item !== undefined);
        return cleanedArray.length ? cleanedArray : undefined;
    }

    if (typeof record === 'object') {
        const cleaned = {};
        for (const [key, value] of Object.entries(record)) {
            const cleanedValue = sanitizeRecord(value);
            if (cleanedValue !== undefined) cleaned[key] = cleanedValue;
        }
        return Object.keys(cleaned).length ? cleaned : undefined;
    }

    if (typeof record === 'string') {
        const value = normalizeWhitespace(record);
        return value || undefined;
    }

    return record;
}

function orderOutputRecord(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return record;

    const ordered = {};

    for (const key of OUTPUT_KEY_ORDER) {
        if (Object.prototype.hasOwnProperty.call(record, key)) {
            ordered[key] = record[key];
        }
    }

    for (const [key, value] of Object.entries(record)) {
        if (!Object.prototype.hasOwnProperty.call(ordered, key)) {
            ordered[key] = value;
        }
    }

    return ordered;
}

function parseDefinitionMap($) {
    const values = new Map();

    $('dl dt').each((_, element) => {
        const label = normalizeLabel($(element).text());
        const value = normalizeWhitespace($(element).nextAll('dd').first().text());
        if (label && value) values.set(label, value);
    });

    return values;
}

function findTextBySelectors($, selectors) {
    for (const selector of selectors) {
        const value = normalizeWhitespace($(selector).first().text());
        if (value) return value;
    }
    return undefined;
}

function findFollowingContentText($, headingRegex) {
    let match;

    $('h3, h4, dt').each((_, element) => {
        if (match) return;
        const label = normalizeWhitespace($(element).text());
        if (!headingRegex.test(label)) return;

        const next = $(element).nextAll('dd, p, ul, div').first();
        const text = normalizeWhitespace(next.text());
        if (text) match = text;
    });

    return match;
}

function extractArrayBySection($, headingRegex) {
    const values = new Set();

    $('h3, h4, dt').each((_, element) => {
        const label = normalizeWhitespace($(element).text());
        if (!headingRegex.test(label)) return;

        const container = $(element).nextAll('dd, ul, p, div').first();
        if (!container.length) return;

        const childItems = container.find('li, span, p');
        if (childItems.length) {
            childItems.each((__, child) => {
                const value = normalizeWhitespace($(child).text());
                if (value) values.add(value);
            });
        } else {
            const raw = normalizeWhitespace(container.text());
            if (!raw) return;
            for (const part of raw.split(/[;,\n]/)) {
                const value = normalizeWhitespace(part);
                if (value) values.add(value);
            }
        }
    });

    return [...values];
}

function parseTapestryPayload(body) {
    try {
        const parsed = JSON.parse(body);
        const tapestry = parsed?._tapestry || {};
        const content = Array.isArray(tapestry.content) ? tapestry.content : [];
        const inits = Array.isArray(tapestry.inits) ? tapestry.inits : [];
        return { content, inits };
    } catch {
        return { content: [], inits: [] };
    }
}

function getInitOverListings(tapestryInits) {
    const initOver = tapestryInits.find(
        (entry) => Array.isArray(entry) && entry[0] === 'rechercheoffres/recherche-offres:initOver',
    );

    if (!initOver || !Array.isArray(initOver[1])) return [];

    return initOver[1]
        .map((entry) => {
            const content = entry?.content || {};
            const offerId = normalizeWhitespace(content.id);
            if (!offerId) return undefined;

            const contractParts = parseContractText(content.contract);
            const location = stripHtmlToText(content.address).replace(/\s*Voir l'itineraire$/i, '').trim();

            return {
                offer_id: offerId,
                job_title: normalizeWhitespace(content.title),
                company: normalizeWhitespace(content.subtitle),
                description_text: normalizeWhitespace(content.description),
                date_posted: normalizeWhitespace(content.subdescription),
                location,
                contract_type: contractParts.contract_type,
                work_hours: contractParts.work_hours,
                latitude: entry?.coordonnees?.lat,
                longitude: entry?.coordonnees?.lon,
                url: `${BASE_URL}/offres/recherche/detail/${offerId}`,
            };
        })
        .filter(Boolean);
}

function getDetailHtmlFromTapestry(body) {
    const { content } = parseTapestryPayload(body);
    if (!content.length) return '';

    const detailEntry = content.find((entry) => entry[0] === 'detailOffreVolet');
    if (detailEntry?.[1]) return String(detailEntry[1]);

    return content.map((entry) => String(entry[1] || '')).join('');
}

function extractDetailData(detailHtml, listing) {
    const $ = cheerioLoad(detailHtml || '');
    const offerId = listing.offer_id;

    let jobTitle = findTextBySelectors($, ['h1', '.sticky-title-container .title', '[itemprop="title"]']);
    if (jobTitle && offerId) {
        const titlePrefix = new RegExp(`^Offre\\s*n[°o]?\\s*${offerId}\\s*`, 'i');
        jobTitle = normalizeWhitespace(jobTitle.replace(titlePrefix, ''));
    }

    let location;
    $('span, p, dd, li').each((_, element) => {
        if (location) return;
        const text = normalizeWhitespace($(element).text());
        if (/^\d{2,3}\s*-\s*\S/.test(text)) location = text;
    });

    const definitions = parseDefinitionMap($);

    const descriptionContainer = $('div[itemprop="description"], .description').first();
    const descriptionHtmlRaw = descriptionContainer.html();
    const descriptionHtml = descriptionHtmlRaw ? String(descriptionHtmlRaw).trim() : undefined;
    const descriptionText = firstNonEmpty(
        stripHtmlToText(descriptionHtmlRaw),
        normalizeWhitespace(descriptionContainer.text()),
        listing.description_text,
    );

    const skills = extractArrayBySection($, /(competences|competence)/i);
    const languages = extractArrayBySection($, /langue/i);

    const result = {
        ...listing,
        job_title: firstNonEmpty(jobTitle, listing.job_title),
        company: firstNonEmpty(
            findTextBySelectors($, [
                '[data-test="company-name"]',
                '.company-name',
                '.media-body p.title',
                'h3.t4.title',
                'h4.t4.title',
            ]),
            listing.company,
        ),
        location: firstNonEmpty(location, listing.location),
        contract_type: firstNonEmpty(definitions.get('type de contrat'), listing.contract_type),
        work_hours: firstNonEmpty(definitions.get('duree du travail'), listing.work_hours),
        salary: firstNonEmpty(definitions.get('salaire')),
        date_posted: firstNonEmpty(
            findTextBySelectors($, ['[itemprop="datePosted"]']),
            findFollowingContentText($, /publie|publi[eé]/i),
            listing.date_posted,
        ),
        description_text: descriptionText,
        description_html: firstNonEmpty(descriptionHtml),
        experience: firstNonEmpty(
            normalizeWhitespace($('[itemprop="experienceRequirements"]').first().text()),
            definitions.get('experience'),
            findFollowingContentText($, /experience|exp[ée]rience/i),
        ),
        formation: firstNonEmpty(
            normalizeWhitespace($('[itemprop="educationRequirements"]').first().text()),
            definitions.get('formation'),
            findFollowingContentText($, /formation|education/i),
        ),
        skills,
        languages,
        qualification: firstNonEmpty(
            definitions.get('qualification'),
            findFollowingContentText($, /qualification/i),
        ),
        sector: firstNonEmpty(
            definitions.get('secteur d activite'),
            findFollowingContentText($, /secteur d.?activite/i),
        ),
        url: listing.url,
    };

    // Keep description_text aligned with description_html whenever HTML is present.
    if (!result.description_text && result.description_html) {
        result.description_text = stripHtmlToText(result.description_html);
    }

    return orderOutputRecord(result);
}

async function mapWithConcurrency(items, concurrency, mapper) {
    if (!items.length) return [];

    const results = new Array(items.length);
    let index = 0;

    async function worker() {
        while (true) {
            const current = index++;
            if (current >= items.length) return;
            results[current] = await mapper(items[current], current);
        }
    }

    const workerCount = Math.min(concurrency, items.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
}

async function pushInBatches(items, batchSize) {
    if (!items.length) return;

    for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        await Dataset.pushData(batch);
    }
}

async function main() {
    try {
        const input = (await Actor.getInput()) || {};
        const {
            keyword = '',
            location = '',
            contractType = '',
            results_wanted: resultsWantedRaw = 20,
            max_pages: maxPagesRaw = 10,
            collectDetails = true,
            startUrl,
            proxyConfiguration,
        } = input;

        const resultsWanted = Number.isFinite(+resultsWantedRaw) ? Math.max(1, +resultsWantedRaw) : 20;
        const maxPages = Number.isFinite(+maxPagesRaw) ? Math.max(1, +maxPagesRaw) : 10;

        const proxyConf = proxyConfiguration
            ? await Actor.createProxyConfiguration({ ...proxyConfiguration })
            : undefined;

        const headerGenerator = new HeaderGenerator({
            browsers: [{ name: 'chrome', minVersion: 120, maxVersion: 130 }],
            devices: ['desktop'],
            operatingSystems: ['windows'],
            locales: ['fr-FR', 'fr'],
        });

        const buildSearchUrl = () => {
            const url = new URL(`${BASE_URL}/offres/recherche`);
            if (keyword) url.searchParams.set('motsCles', keyword.trim());
            if (location) url.searchParams.set('lieux', location.trim());
            if (contractType) url.searchParams.set('natureContrat', contractType.trim());
            url.searchParams.set('offresPartenaires', 'true');
            url.searchParams.set('rayon', String(SEARCH_RADIUS_KM));
            url.searchParams.set('tri', '0');
            return url.toString();
        };

        const getBaseHeaders = (isAjax) => {
            const headers = headerGenerator.getHeaders({
                operatingSystems: ['windows'],
                browsers: ['chrome'],
                devices: ['desktop'],
                locales: ['fr-FR'],
            });

            return {
                ...headers,
                accept: isAjax
                    ? 'application/json, text/javascript, */*; q=0.01'
                    : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'accept-language': 'fr-FR,fr;q=0.9,en-US;q=0.5,en;q=0.3',
                'accept-encoding': 'gzip, deflate, br',
                'cache-control': 'max-age=0',
                'sec-ch-ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"Windows"',
                ...(isAjax ? { 'x-requested-with': 'XMLHttpRequest' } : {}),
            };
        };

        const request = async (url, { method = 'GET', isAjax = false, cookies = '' } = {}) => {
            const proxyUrl = proxyConf ? await proxyConf.newUrl() : undefined;
            const headers = getBaseHeaders(isAjax);
            if (cookies) headers.cookie = cookies;

            const response = await gotScraping({
                url,
                method,
                headers,
                proxyUrl,
                throwHttpErrors: false,
                responseType: 'text',
                timeout: { request: 30000 },
                retry: { limit: 2 },
            });

            const rawCookies = response.headers['set-cookie'] || [];
            const newCookies = (Array.isArray(rawCookies) ? rawCookies : [rawCookies])
                .filter(Boolean)
                .map((item) => item.split(';')[0])
                .join('; ');

            return {
                statusCode: response.statusCode,
                body: response.body,
                newCookies,
            };
        };

        const initialUrl = startUrl || buildSearchUrl();
        const parsedInitialUrl = new URL(initialUrl);
        const queryString = parsedInitialUrl.search.replace(/^\?/, '');

        log.info(`Starting scrape from: ${initialUrl}`);

        const initResponse = await request(initialUrl, { method: 'GET', isAjax: false });
        if (initResponse.statusCode !== 200) {
            throw new Error(`Initial request failed with status ${initResponse.statusCode}`);
        }

        let cookies = initResponse.newCookies || '';
        const listings = [];
        const seenIds = new Set();

        for (let page = 0; page < maxPages && listings.length < resultsWanted; page++) {
            const rangeStart = page * PAGE_SIZE;
            const rangeEnd = rangeStart + PAGE_SIZE - 1;
            const pageUrl = `${BASE_URL}/offres/recherche.rechercheoffre:afficherplusderesultats/${rangeStart}-${rangeEnd}/0?${queryString}`;

            const response = await request(pageUrl, {
                method: 'POST',
                isAjax: true,
                cookies,
            });

            if (response.newCookies) {
                cookies = mergeCookies(cookies, response.newCookies);
            }

            if (response.statusCode !== 200) {
                log.warning(`Listing page ${page + 1} failed with status ${response.statusCode}`);
                break;
            }

            const { inits } = parseTapestryPayload(response.body);
            const pageListings = getInitOverListings(inits);

            if (!pageListings.length) {
                log.info(`No listings returned at page ${page + 1}, stopping pagination.`);
                break;
            }

            for (const listing of pageListings) {
                if (seenIds.has(listing.offer_id)) continue;
                seenIds.add(listing.offer_id);
                listings.push(listing);
                if (listings.length >= resultsWanted) break;
            }

            log.info(`Listings page ${page + 1}: +${pageListings.length} fetched, ${listings.length}/${resultsWanted} collected.`);

            if (pageListings.length < PAGE_SIZE) break;
        }

        const jobsToProcess = listings.slice(0, resultsWanted);

        if (!jobsToProcess.length) {
            log.warning('No job listings found with the selected filters.');
            return;
        }

        if (!collectDetails) {
            const output = jobsToProcess
                .map((item) => {
                    const ordered = orderOutputRecord(item);
                    return OMIT_NULL_VALUES ? sanitizeRecord(ordered) : ordered;
                })
                .filter(Boolean);

            await pushInBatches(output, PUSH_BATCH_SIZE);
            log.info(`Finished. Saved ${output.length} listing item(s) without detail expansion.`);
            return;
        }

        const progressStep = Math.max(10, DETAIL_CONCURRENCY * 2);
        let completed = 0;

        const detailedItems = await mapWithConcurrency(jobsToProcess, DETAIL_CONCURRENCY, async (listing) => {
            const detailUrl = `${BASE_URL}/offres/recherche.rechercheoffre.voletdetail:chargerdetail?${queryString}&idOffre=${listing.offer_id}&indexFin=0&navigation=`;

            try {
                const response = await request(detailUrl, {
                    method: 'POST',
                    isAjax: true,
                    cookies,
                });

                let detailHtml = '';

                if (response.statusCode === 200) {
                    detailHtml = getDetailHtmlFromTapestry(response.body);
                }

                if (!detailHtml || detailHtml.length < 120) {
                    const fallback = await request(listing.url, {
                        method: 'GET',
                        isAjax: false,
                        cookies,
                    });
                    if (fallback.statusCode === 200) detailHtml = fallback.body;
                }

                const extracted = extractDetailData(detailHtml, listing);
                return OMIT_NULL_VALUES ? sanitizeRecord(extracted) : extracted;
            } catch (error) {
                log.warning(`Detail fetch failed for ${listing.offer_id}: ${error.message}`);
                const orderedFallback = orderOutputRecord(listing);
                return OMIT_NULL_VALUES ? sanitizeRecord(orderedFallback) : orderedFallback;
            } finally {
                completed++;
                if (completed % progressStep === 0 || completed === jobsToProcess.length) {
                    log.info(`Detail progress: ${completed}/${jobsToProcess.length}`);
                }
            }
        });

        const cleanedItems = detailedItems.filter(Boolean);
        await pushInBatches(cleanedItems, PUSH_BATCH_SIZE);

        log.info(`Finished. Saved ${cleanedItems.length} job(s) in batches of ${PUSH_BATCH_SIZE}.`);
    } finally {
        await Actor.exit();
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
