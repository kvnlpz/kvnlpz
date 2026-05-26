/**
 * scripts/update-letterboxd.js
 *
 * Fetches the Letterboxd RSS feed for the configured username, parses the XML,
 * and rewrites the block between <!-- NOW:START --> and <!-- NOW:END --> in
 * README.md with the most recent watched films.
 *
 * Only dependency is fast-xml-parser. Uses Node's built-in fetch (Node 18+).
 *
 * Design notes:
 *   - The Letterboxd RSS feed is the only source of truth. If you haven't
 *     logged anything yet, the feed has no <item> elements and we render a
 *     friendly placeholder instead of breaking.
 *   - We cap output at MAX_ITEMS so the README doesn't get huge.
 *   - We only touch the text between the markers. Everything else stays put.
 */

const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');

// ---- Configuration ---------------------------------------------------------

/** Letterboxd username, pulled from your profile URL: letterboxd.com/<USERNAME>/ */
const LETTERBOXD_USERNAME = 'kvnlpz';

/** Max number of recent diary entries to render. */
const MAX_ITEMS = 5;

/** Path to the README, relative to the repo root (cwd in the Action). */
const README_PATH = path.join(process.cwd(), 'README.md');

/** Markers that bracket the section we manage. */
const START_MARKER = '<!-- NOW:START -->';
const END_MARKER = '<!-- NOW:END -->';

// ---- Helpers ---------------------------------------------------------------

/**
 * Fetches the raw RSS XML for the configured Letterboxd user.
 *
 * @returns {Promise<string>} the response body as XML text
 * @throws if the HTTP request fails or returns a non-2xx status
 */
async function fetchRssXml() {
    const url = `https://letterboxd.com/${LETTERBOXD_USERNAME}/rss/`;
    const response = await fetch(url, {
        // Polite, descriptive user agent. Some hosts block default Node UAs.
        headers: { 'User-Agent': `${LETTERBOXD_USERNAME}-readme-bot (github-actions)` },
    });

    if (!response.ok) {
        throw new Error(`Letterboxd RSS fetch failed: HTTP ${response.status}`);
    }

    return await response.text();
}

/**
 * Parses the Letterboxd RSS XML into a normalized list of diary entries.
 * Lists and other non-diary items are filtered out.
 *
 * @param {string} xml raw RSS feed contents
 * @returns {Array<{title:string, year:string, rating:string|null, watchedDate:string, link:string}>}
 */
function parseDiaryEntries(xml) {
    // ignoreAttributes:false keeps attributes available if we ever want them.
    // isArray ensures <item> is always an array even if there's only one entry,
    // saving us a special case downstream.
    const parser = new XMLParser({
        ignoreAttributes: false,
        isArray: (name) => name === 'item',
    });

    const parsed = parser.parse(xml);
    const items = parsed?.rss?.channel?.item ?? [];

    return items
        // Diary entries have a filmTitle; lists don't. Simple filter.
        .filter((item) => item['letterboxd:filmTitle'])
        .map((item) => ({
            title: item['letterboxd:filmTitle'],
            year: item['letterboxd:filmYear'] ?? '',
            // Rating is 0.5-5 in 0.5 increments. Missing if you didn't rate it.
            rating: item['letterboxd:memberRating'] ?? null,
            watchedDate: item['letterboxd:watchedDate'] ?? '',
            link: item.link ?? '',
        }))
        .slice(0, MAX_ITEMS);
}

/**
 * Renders a numeric Letterboxd rating (e.g. 3.5) as a star string (★★★½).
 * Returns an empty string if rating is null/undefined/non-numeric.
 *
 * @param {number|string|null} rating
 * @returns {string}
 */
function renderStars(rating) {
    if (rating === null || rating === undefined || rating === '') return '';

    const numeric = Number(rating);
    if (Number.isNaN(numeric)) return '';

    const fullStars = Math.floor(numeric);
    const hasHalf = numeric - fullStars >= 0.5;

    return '★'.repeat(fullStars) + (hasHalf ? '½' : '');
}

/**
 * Builds the Markdown block that replaces the content between the markers.
 *
 * @param {Array} entries diary entries from parseDiaryEntries
 * @returns {string} Markdown ready to splice into the README
 */
function buildMarkdown(entries) {
    if (entries.length === 0) {
        return '_Nothing logged yet. Check back soon._';
    }

    const lines = entries.map((entry) => {
        const stars = renderStars(entry.rating);
        const ratingFragment = stars ? ` — ${stars}` : '';
        const yearFragment = entry.year ? ` (${entry.year})` : '';
        return `- [**${entry.title}**${yearFragment}](${entry.link})${ratingFragment}`;
    });

    // Footer link back to the full diary, so the curious can dig deeper.
    lines.push('');
    lines.push(
        `<sub>Latest from my [Letterboxd diary](https://letterboxd.com/${LETTERBOXD_USERNAME}/films/diary/).</sub>`
    );

    return lines.join('\n');
}

/**
 * Replaces the block between START_MARKER and END_MARKER with new content.
 * The markers themselves are preserved.
 *
 * @param {string} readme current README contents
 * @param {string} newBlock new Markdown content to insert (without markers)
 * @returns {string} updated README contents
 * @throws if the markers can't be found in the README
 */
function spliceReadme(readme, newBlock) {
    const startIdx = readme.indexOf(START_MARKER);
    const endIdx = readme.indexOf(END_MARKER);

    if (startIdx === -1 || endIdx === -1) {
        throw new Error(
            `Could not find markers ${START_MARKER} / ${END_MARKER} in README. Add them first.`
        );
    }
    if (endIdx < startIdx) {
        throw new Error('END marker appears before START marker. Check ordering.');
    }

    // Keep the markers in place; replace only what's between.
    const before = readme.slice(0, startIdx + START_MARKER.length);
    const after = readme.slice(endIdx);

    return `${before}\n${newBlock}\n${after}`;
}

// ---- Main entry ------------------------------------------------------------

(async () => {
    try {
        console.log(`Fetching Letterboxd RSS for ${LETTERBOXD_USERNAME}...`);
        const xml = await fetchRssXml();

        const entries = parseDiaryEntries(xml);
        console.log(`Parsed ${entries.length} diary entries.`);

        const newBlock = buildMarkdown(entries);
        const currentReadme = fs.readFileSync(README_PATH, 'utf8');
        const updatedReadme = spliceReadme(currentReadme, newBlock);

        if (currentReadme === updatedReadme) {
            console.log('README already up to date.');
            return;
        }

        fs.writeFileSync(README_PATH, updatedReadme, 'utf8');
        console.log('README updated.');
    } catch (err) {
        // Non-zero exit so the Action fails visibly if something breaks.
        console.error('Update failed:', err);
        process.exit(1);
    }
})();
