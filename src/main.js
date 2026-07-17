// France Travail Jobs Scraper - API-first with batched writes and reduced logging
import { Actor, log } from 'apify';
import { load as cheerioLoad } from 'cheerio';
import { Impit } from 'impit';

const BASE_URL = 'https://candidat.francetravail.fr';
const PAGE_SIZE = 20;
const SEARCH_RADIUS_KM = 10;
const DETAIL_CONCURRENCY = 8;
const PUSH_BATCH_SIZE = 25;
const REQUEST_TIMEOUT_MS = 30000;
const REQUEST_RETRIES = 2;
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const OMIT_NULL_VALUES = true;
const OUTPUT_KEY_ORDER = [
    'offer_id',
    'job_title',
    'company',
    'location',
    'postal_code',
    'address_locality',
    'address_region',
    'address_country',
    'contract_type',
    'employment_type',
    'work_hours',
    'work_conditions',
    'travel_required',
    'salary',
    'salary_currency',
    'salary_unit',
    'date_posted',
    'valid_through',
    'description_text',
    'description_html',
    'experience',
    'formation',
    'skills',
    'soft_skills',
    'languages',
    'qualification',
    'sector',
    'employer_name',
    'employer_website',
    'contact_email',
    'contact_phone',
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

function extractSetCookies(headers) {
    const rawCookies = typeof headers.getSetCookie === 'function'
        ? headers.getSetCookie()
        : [headers.get('set-cookie')];

    return rawCookies
        .filter(Boolean)
        .flatMap((item) => String(item).split(/,(?=[^;,]+=)/))
        .map((item) => item.split(';')[0].trim())
        .filter(Boolean)
        .join('; ');
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

function getItempropValue($, prop) {
    const element = $(`[itemprop="${prop}"]`).first();
    if (!element.length) return undefined;

    return firstNonEmpty(
        element.attr('content'),
        element.attr('datetime'),
        element.attr('href'),
        element.attr('value'),
        element.text(),
    );
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

function extractJsonArrayAt(text, startIndex) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = startIndex; index < text.length; index++) {
        const char = text[index];

        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }

        if (char === '"') {
            inString = true;
        } else if (char === '[') {
            depth++;
        } else if (char === ']') {
            depth--;
            if (depth === 0) return text.slice(startIndex, index + 1);
        }
    }

    return '';
}

function parseTapestryPayload(body) {
    try {
        const parsed = JSON.parse(body);
        const { _tapestry: tapestry = {} } = parsed ?? {};
        const content = Array.isArray(tapestry.content) ? tapestry.content : [];
        const inits = Array.isArray(tapestry.inits) ? tapestry.inits : [];
        return { content, inits };
    } catch {
        return { content: [], inits: [] };
    }
}

function getInitialPageListings(body) {
    const marker = '"rechercheoffres/recherche-offres:initOver"';
    const markerIndex = body.indexOf(marker);
    if (markerIndex < 0) return getListingCardsFromHtml(body);

    const startIndex = body.lastIndexOf('[', markerIndex);
    if (startIndex < 0) return getListingCardsFromHtml(body);

    try {
        const initOver = JSON.parse(extractJsonArrayAt(body, startIndex));
        const listings = getInitOverListings([initOver]);
        return listings.length ? listings : getListingCardsFromHtml(body);
    } catch {
        return getListingCardsFromHtml(body);
    }
}

function getListingCardsFromHtml(html) {
    if (!html) return [];

    const $ = cheerioLoad(html);
    const listings = [];

    $('[data-id-offre]').each((_, element) => {
        const card = $(element);
        const offerId = normalizeWhitespace(card.attr('data-id-offre'));
        if (!offerId) return;

        const href = card.find(`a[href*="${offerId}"], a[href*="/detail/"]`).first().attr('href');
        const url = href
            ? new URL(href, BASE_URL).toString()
            : `${BASE_URL}/offres/recherche/detail/${offerId}`;
        const location = firstNonEmpty(
            card.find('[itemprop="address"], .location, .subtext').first().text(),
            card.text().match(/\b\d{2,3}\s*-\s*[A-ZÀ-Ÿ][A-ZÀ-Ÿ -]+/)?.[0],
        );

        listings.push({
            offer_id: offerId,
            job_title: firstNonEmpty(
                card.find('[itemprop="title"], h2, h3, .media-heading, .title').first().text(),
            ),
            company: firstNonEmpty(
                card.find('[itemprop="hiringOrganization"], .company, .subtitle').first().text(),
            ),
            description_text: firstNonEmpty(card.find('.description, p').first().text()),
            date_posted: firstNonEmpty(card.find('time, .date').first().text()),
            location,
            url,
        });
    });

    return listings;
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

function getTapestryHtmlListings(body) {
    const { content } = parseTapestryPayload(body);
    const html = content.map((entry) => String(entry?.[1] || '')).join('');
    return getListingCardsFromHtml(html);
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
    const softSkills = extractArrayBySection($, /savoir[- ]?etre|savoir-être/i);
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
        employment_type: firstNonEmpty(getItempropValue($, 'employmentType'), definitions.get('type de contrat')),
        work_hours: firstNonEmpty(definitions.get('duree du travail'), listing.work_hours),
        work_conditions: firstNonEmpty(definitions.get('conditions de travail')),
        travel_required: firstNonEmpty(definitions.get('deplacements')),
        salary: firstNonEmpty(definitions.get('salaire')),
        salary_currency: firstNonEmpty(getItempropValue($, 'currency')),
        salary_unit: firstNonEmpty(getItempropValue($, 'unitText')),
        date_posted: firstNonEmpty(
            findTextBySelectors($, ['[itemprop="datePosted"]']),
            findFollowingContentText($, /publie|publi[eé]/i),
            listing.date_posted,
        ),
        valid_through: firstNonEmpty(getItempropValue($, 'validThrough')),
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
        soft_skills: softSkills,
        languages,
        qualification: firstNonEmpty(
            normalizeWhitespace($('[itemprop="qualifications"]').first().text()),
            definitions.get('qualification'),
            findFollowingContentText($, /qualification/i),
        ),
        sector: firstNonEmpty(
            normalizeWhitespace($('[itemprop="industry"]').first().text()),
            definitions.get('secteur d activite'),
            findFollowingContentText($, /secteur d.?activite/i),
        ),
        postal_code: firstNonEmpty(getItempropValue($, 'postalCode')),
        address_locality: firstNonEmpty(getItempropValue($, 'addressLocality')),
        address_region: firstNonEmpty(getItempropValue($, 'addressRegion')),
        address_country: firstNonEmpty(getItempropValue($, 'addressCountry')),
        employer_name: firstNonEmpty(getItempropValue($, 'hiringOrganization'), listing.company),
        employer_website: firstNonEmpty(
            definitions.get('site internet'),
            $('a[href^="http"]').filter((_, element) => /site internet/i.test(normalizeWhitespace($(element).text()))).first().attr('href'),
        ),
        contact_email: firstNonEmpty(getItempropValue($, 'email')),
        contact_phone: firstNonEmpty(getItempropValue($, 'telephone')),
        url: listing.url,
    };

    // Keep description_text aligned with description_html whenever HTML is present.
    if (!result.description_text && result.description_html) {
        result.description_text = stripHtmlToText(result.description_html);
    }

    return orderOutputRecord(result);
}

function createDatasetBatchWriter(dataset, batchSize) {
    const buffer = [];
    let total = 0;
    let chain = Promise.resolve();

    const flush = async () => {
        if (!buffer.length) return 0;

        const batch = buffer.splice(0, buffer.length);
        await dataset.pushData(batch);
        total += batch.length;
        return batch.length;
    };

    return {
        add(item) {
            if (!item) return chain;

            chain = chain.then(async () => {
                buffer.push(item);
                if (buffer.length >= batchSize) await flush();
            });

            return chain;
        },
        async flush() {
            chain = chain.then(flush);
            return chain;
        },
        get total() {
            return total;
        },
    };
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

async function pushInBatches(dataset, items, batchSize) {
    if (!items.length) return;

    for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        await dataset.pushData(batch);
    }
}

async function main() {
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

    const hasCustomProxyUrls = Array.isArray(proxyConfiguration?.proxyUrls) && proxyConfiguration.proxyUrls.length > 0;
    const shouldCreateProxy = proxyConfiguration && (Actor.isAtHome() || hasCustomProxyUrls);
    if (proxyConfiguration?.useApifyProxy && !Actor.isAtHome() && !hasCustomProxyUrls) {
        log.warning('Apify Proxy requested but not available locally. Continuing without proxy.');
    }

    const proxyConf = shouldCreateProxy
        ? await Actor.createProxyConfiguration({ ...proxyConfiguration })
        : undefined;

        const proxyUrl = proxyConf ? await proxyConf.newUrl() : undefined;
        const client = new Impit({
            browser: 'chrome',
            ignoreTlsErrors: true,
            ...(proxyUrl && { proxyUrl }),
        });
        const dataset = await Actor.openDataset();
        const batchWriter = createDatasetBatchWriter(dataset, PUSH_BATCH_SIZE);

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

        const request = async (url, {
            method = 'GET',
            isAjax = false,
            cookies = '',
            referer = '',
        } = {}) => {
            const headers = {};
            if (isAjax) headers['x-requested-with'] = 'XMLHttpRequest';
            if (cookies) headers.cookie = cookies;
            if (referer) headers.referer = referer;

            for (let attempt = 0; attempt <= REQUEST_RETRIES; attempt++) {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

                try {
                    const response = await client.fetch(url, {
                        method,
                        headers,
                        signal: controller.signal,
                    });

                    const body = await response.text();
                    const newCookies = extractSetCookies(response.headers);

                    if (RETRYABLE_STATUS_CODES.has(response.status) && attempt < REQUEST_RETRIES) {
                        const delayMs = (attempt + 1) * 1500;
                        log.warning(`HTTP ${response.status} received. Retrying in ${delayMs / 1000}s.`);
                        await new Promise((resolve) => {
                            setTimeout(resolve, delayMs);
                        });
                        continue;
                    }

                    return {
                        statusCode: response.status,
                        body,
                        newCookies,
                    };
                } catch (error) {
                    if (attempt >= REQUEST_RETRIES) throw error;
                    const delayMs = (attempt + 1) * 1000;
                    log.warning(`Request failed: ${error.message}. Retrying in ${delayMs / 1000}s.`);
                    await new Promise((resolve) => {
                        setTimeout(resolve, delayMs);
                    });
                } finally {
                    clearTimeout(timeout);
                }
            }

            throw new Error('Request failed');
        };

        const initialUrl = startUrl || buildSearchUrl();
        const parsedInitialUrl = new URL(initialUrl);
        const queryString = parsedInitialUrl.search.replace(/^\?/, '');

        log.info('Starting scrape.');

        const initResponse = await request(initialUrl, { method: 'GET', isAjax: false });
        if (initResponse.statusCode !== 200) {
            throw new Error(`Initial request failed with status ${initResponse.statusCode}`);
        }

        let cookies = initResponse.newCookies || '';
        const seenIds = new Set();
        let savedCount = 0;

        for (let page = 0; page < maxPages && savedCount < resultsWanted; page++) {
            let pageListings;

            if (page === 0) {
                pageListings = getInitialPageListings(initResponse.body);
            } else {
                const rangeStart = page * PAGE_SIZE;
                const rangeEnd = rangeStart + PAGE_SIZE - 1;
                const pageUrl = `${BASE_URL}/offres/recherche.rechercheoffre:afficherplusderesultats/${rangeStart}-${rangeEnd}/0?${queryString}`;

                const response = await request(pageUrl, {
                    method: 'POST',
                    isAjax: true,
                    cookies,
                    referer: initialUrl,
                });

                if (response.newCookies) {
                    cookies = mergeCookies(cookies, response.newCookies);
                }

                if (response.statusCode !== 200) {
                    log.warning(`Listing page ${page + 1} failed with status ${response.statusCode}`);
                    break;
                }

                const { inits } = parseTapestryPayload(response.body);
                pageListings = getInitOverListings(inits);
                if (!pageListings.length) {
                    pageListings = getTapestryHtmlListings(response.body);
                }
            }

            if (!pageListings.length) {
                log.info(`No listings returned at page ${page + 1}, stopping pagination.`);
                break;
            }

            const pageJobs = [];
            for (const listing of pageListings) {
                if (seenIds.has(listing.offer_id)) continue;
                seenIds.add(listing.offer_id);
                pageJobs.push(listing);
                if (savedCount + pageJobs.length >= resultsWanted) break;
            }

            log.info(`Listings page ${page + 1}: +${pageListings.length} fetched, ${savedCount + pageJobs.length}/${resultsWanted} collected.`);

            if (pageJobs.length) {
                if (!collectDetails) {
                    const output = pageJobs
                        .map((item) => {
                            const ordered = orderOutputRecord(item);
                            return OMIT_NULL_VALUES ? sanitizeRecord(ordered) : ordered;
                        })
                        .filter(Boolean);

                    await pushInBatches(dataset, output, PUSH_BATCH_SIZE);
                    savedCount += output.length;
                    log.info(`Saved ${savedCount}/${resultsWanted} listing item(s) without detail expansion.`);
                } else {
                    const progressStep = Math.max(10, DETAIL_CONCURRENCY * 2);
                    let completed = 0;

                    const pageCookies = cookies;
                    let pageSaved = 0;
                    await mapWithConcurrency(pageJobs, DETAIL_CONCURRENCY, async (listing) => {
                        const detailUrl = `${BASE_URL}/offres/recherche.rechercheoffre.voletdetail:chargerdetail?${queryString}&idOffre=${listing.offer_id}&indexFin=0&navigation=`;

                        try {
                            const detailResponse = await request(detailUrl, {
                                method: 'POST',
                                isAjax: true,
                                cookies: pageCookies,
                                referer: initialUrl,
                            });

                            let detailHtml = '';

                            if (detailResponse.statusCode === 200) {
                                detailHtml = getDetailHtmlFromTapestry(detailResponse.body);
                            }

                            if (!detailHtml || detailHtml.length < 120) {
                                const fallback = await request(listing.url, {
                                    method: 'GET',
                                    isAjax: false,
                                    cookies: pageCookies,
                                });
                                if (fallback.statusCode === 200) detailHtml = fallback.body;
                            }

                            const extracted = extractDetailData(detailHtml, listing);
                            const item = OMIT_NULL_VALUES ? sanitizeRecord(extracted) : extracted;
                            await batchWriter.add(item);
                            if (item) pageSaved++;
                            return item;
                        } catch (error) {
                            log.warning(`Detail fetch failed for ${listing.offer_id}: ${error.message}`);
                            const orderedFallback = orderOutputRecord(listing);
                            const item = OMIT_NULL_VALUES ? sanitizeRecord(orderedFallback) : orderedFallback;
                            await batchWriter.add(item);
                            if (item) pageSaved++;
                            return item;
                        } finally {
                            completed++;
                            if (completed % progressStep === 0 || completed === pageJobs.length) {
                                log.info(`Page ${page + 1} detail progress: ${completed}/${pageJobs.length}`);
                            }
                        }
                    });

                    await batchWriter.flush();
                    savedCount += pageSaved;
                    log.info(`Saved ${savedCount}/${resultsWanted} job(s) after page ${page + 1}.`);
                }
            }

            if (pageListings.length < PAGE_SIZE) break;
        }

        if (!savedCount) {
            log.warning('No job listings found with the selected filters.');
            return;
        }

        await batchWriter.flush();
    log.info(`Finished. Saved ${savedCount} job(s). Dataset writes confirmed: ${batchWriter.total}.`);
    await Actor.exit();
}

main().catch(async (error) => {
    log.error(error instanceof Error ? error.stack || error.message : String(error));
    await Actor.exit({ exitCode: 1 });
});
