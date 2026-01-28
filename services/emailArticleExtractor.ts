/**
 * Email Article Extractor
 *
 * Uses cheerio (HTML parser) to intelligently extract individual articles
 * from academic email alerts, reducing the number of API calls needed.
 */

import * as cheerio from 'cheerio';
import { logger } from '../utils/logger.ts';

export interface ExtractedArticle {
  title: string;
  authors?: string;
  abstract?: string;
  doi?: string;
  journal?: string;
  htmlContent: string; // Full HTML block for this article
  estimatedTokens: number;
}

/**
 * Estimate token count for text (rough: ~4 chars per token)
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Extract articles from Cell Press emails
 * Cell Press emails have articles in <a> tags with specific styling
 * Titles are in the link text, descriptions in surrounding <p> tags
 */
function extractCellPressArticles(html: string, emailSubject: string = ''): ExtractedArticle[] {
  const $ = cheerio.load(html);
  const articles: ExtractedArticle[] = [];

  // Cell Press structure:
  // <td><a style="...color: #007DBC...">ACTUAL TITLE</a></td>
  // Followed by author info and possibly description

  // Detect specific Cell Press journal from subject
  const cellJournals = [
    'Cell Reports Medicine',
    'Cell Reports Physical Science',
    'Cell Reports Methods',
    'Cell Stem Cell',
    'Cell Reports',
    'Cell Metabolism',
    'Cell Systems',
    'Cell Chemical Biology',
    'Cell Host & Microbe',
    'Developmental Cell',
    'Molecular Cell',
    'Cancer Cell',
    'Cell Genomics',
    'Immunity',
    'Neuron',
    'Structure',
    'iScience',
    'Cell' // Put this last to avoid false matches with compound names
  ];

  let defaultJournal = 'Cell Press';
  const subjectLower = emailSubject.toLowerCase();

  for (const journal of cellJournals) {
    if (subjectLower.includes(journal.toLowerCase())) {
      defaultJournal = journal;
      logger.info(`[ArticleExtractor] Detected Cell Press journal from subject: ${journal}`);
      break;
    }
  }

  // Strategy: Find article links with Cell Press styling
  // Cell Press now uses notification.elsevier.com redirects with URL-encoded cell.com links
  $('a').each((i, elem) => {
    const $link = $(elem);
    const href = $link.attr('href') || '';
    const style = $link.attr('style') || '';

    // Check if this is a Cell Press article link (direct or via Elsevier redirect)
    const isCellLink = href.includes('cell.com') ||
                       (href.includes('notification.elsevier.com') && href.includes('cell.com'));

    if (!isCellLink) return;

    // Decode URL-encoded href for pattern matching
    const decodedHref = decodeURIComponent(href);

    // Skip navigation, social, and non-article links
    if (decodedHref.includes('unsubscribe') || decodedHref.includes('facebook') ||
        decodedHref.includes('twitter') || decodedHref.includes('youtube') ||
        decodedHref.includes('issue?pii') || decodedHref.includes('/home') ||
        decodedHref.includes('/pb-assets/') || decodedHref.includes('/archive') ||
        decodedHref.includes('newarticles')) {
      return;
    }

    // Must be an article link (fulltext or article pattern)
    if (!decodedHref.includes('fulltext') && !decodedHref.includes('/article/')) {
      return;
    }

    // Get the link text as title (this is the actual article title)
    let title = $link.text().trim();
    title = title.replace(/\s+/g, ' '); // Normalize whitespace

    // Filter: must be substantial title
    if (title.length < 20 || title.length > 300) return;

    // Skip if it's navigation text
    if (title.toLowerCase().includes('online now') ||
        title.toLowerCase().includes('table of contents') ||
        title.toLowerCase().includes('archive')) return;

    // Get surrounding context for authors and DOI
    const $parent = $link.closest('td, div');
    const contextHtml = $parent.html() || '';

    // Try to extract DOI if present in URL or context
    let doi: string | undefined;
    // DOI from URL (S0092-8674(25)01482-5 format)
    const urlDoiMatch = decodedHref.match(/S(\d{4}-\d{4})\((\d{2})\)(\d{5}-?\d?)/);
    if (urlDoiMatch) {
      doi = `10.1016/j.cell.20${urlDoiMatch[2]}.${urlDoiMatch[3]}`;
    }
    // Fallback: DOI from context
    if (!doi) {
      const ctxDoiMatch = contextHtml.match(/doi[:\s]*([0-9.]+\/S[^\s<>"]+)/i);
      doi = ctxDoiMatch ? ctxDoiMatch[1] : undefined;
    }

    // Cell Press authors are in the NEXT ROW after the title row
    // Structure: <tr><td><a>TITLE</a></td></tr> <tr><td><i>Authors et al.</i></td></tr>
    let authors = '';
    const $row = $link.closest('tr');
    if ($row.length > 0) {
      const $nextRow = $row.next('tr');
      if ($nextRow.length > 0) {
        const $italic = $nextRow.find('i');
        if ($italic.length > 0) {
          const authorText = $italic.first().text().trim();
          // Validate it looks like authors (contains "et al" or has comma-separated names)
          if (authorText.length > 5 && authorText.length < 500 &&
              (authorText.includes('et al') || authorText.includes(','))) {
            authors = authorText;
          }
        }
      }
    }

    // Fallback: check parent td for italic tags
    if (!authors) {
      $parent.find('i').each((j, authorElem) => {
        const text = $(authorElem).text().trim();
        if (text.length > 10 && text.length < 500 &&
            (text.includes('et al') || text.includes(','))) {
          authors = text;
        }
      });
    }

    // Try to detect journal from URL if not in subject
    let journalName = defaultJournal;
    if (defaultJournal === 'Cell Press' && decodedHref) {
      // URL format: cell.com/cell-stem-cell/fulltext/... or cell.com/immunity/fulltext/...
      // Use decoded URL for matching
      const urlJournalMatch = decodedHref.match(/cell\.com\/([^\/]+)\//);
      if (urlJournalMatch) {
        const urlSlug = urlJournalMatch[1];
        // Map URL slug to journal name
        const slugMap: Record<string, string> = {
          'cell-stem-cell': 'Cell Stem Cell',
          'cell-reports': 'Cell Reports',
          'cell-metabolism': 'Cell Metabolism',
          'cell-systems': 'Cell Systems',
          'cell-chemical-biology': 'Cell Chemical Biology',
          'cell-host-microbe': 'Cell Host & Microbe',
          'developmental-cell': 'Developmental Cell',
          'molecular-cell': 'Molecular Cell',
          'cancer-cell': 'Cancer Cell',
          'cell-genomics': 'Cell Genomics',
          'cell-reports-medicine': 'Cell Reports Medicine',
          'cell-reports-physical-science': 'Cell Reports Physical Science',
          'cell-reports-methods': 'Cell Reports Methods',
          'immunity': 'Immunity',
          'neuron': 'Neuron',
          'structure': 'Structure',
          'iscience': 'iScience',
          'cell': 'Cell'
        };
        if (slugMap[urlSlug]) {
          journalName = slugMap[urlSlug];
        }
      }
    }

    articles.push({
      title: title, // EXACT title from link text
      authors: authors || undefined,
      doi: doi,
      journal: journalName,
      htmlContent: contextHtml,
      estimatedTokens: estimateTokens(contextHtml)
    });
  });

  // Deduplicate by title
  const uniqueArticles: ExtractedArticle[] = [];
  const seenTitles = new Set<string>();

  for (const article of articles) {
    const normalizedTitle = article.title.toLowerCase().trim();
    if (!seenTitles.has(normalizedTitle)) {
      seenTitles.add(normalizedTitle);
      uniqueArticles.push(article);
    }
  }

  return uniqueArticles;
}

/**
 * Extract articles from Google Scholar alerts
 * Google Scholar structure: <h3><a>Title</a></h3> followed by citation div and snippet div as siblings
 */
function extractGoogleScholarArticles(html: string): ExtractedArticle[] {
  const $ = cheerio.load(html);
  const articles: ExtractedArticle[] = [];

  // Google Scholar format: <h3><a class="gse_alrt_title">Title</a></h3>
  // followed by <div>citation</div> and <div>snippet</div> as next siblings
  $('h3').each((i, elem) => {
    const $h3 = $(elem);
    const $titleLink = $h3.find('a.gse_alrt_title, a[class*="gse_alrt"]');

    if ($titleLink.length === 0) return;

    const title = $titleLink.text().trim();
    if (!title || title.length < 10) return; // Skip empty/short titles

    const href = $titleLink.attr('href') || '';

    // Use SIBLING traversal to get citation and snippet for THIS article only
    // Structure: <h3>Title</h3> <div>Citation</div> <div>Snippet</div>
    let citation = '';
    let snippet = '';

    // Get next siblings until we hit another h3 or run out
    let $next = $h3.next();
    let siblingCount = 0;
    while ($next.length > 0 && $next.prop('tagName') !== 'H3' && siblingCount < 3) {
      const text = $next.text().trim();
      const style = $next.attr('style') || '';

      // Citation has green color style
      if (style.includes('color:#006621') || style.includes('color: #006621')) {
        citation = text;
      }
      // Snippet is usually the div after citation, or has sni class
      else if ($next.hasClass('gse_alrt_sni') || $next.attr('class')?.includes('sni')) {
        snippet = text;
      }
      // If no specific markers, second div is usually snippet
      else if (text.length > 20 && !citation) {
        citation = text;
      } else if (text.length > 20 && citation && !snippet) {
        snippet = text;
      }

      $next = $next.next();
      siblingCount++;
    }

    // Extract journal name from citation line
    // Format: "Authors - Journal Name, Year"
    // Note: Google Scholar uses non-breaking spaces (code 160) which we need to normalize
    let journalName = 'Google Scholar';
    let authors = '';

    if (citation) {
      // Normalize non-breaking spaces to regular spaces
      const normalizedCitation = citation.replace(/\u00A0/g, ' ');

      // Use regex to find dash separator (handles various dash types)
      const dashMatch = normalizedCitation.match(/^(.+?)\s+[-–—]\s+(.+)$/);
      if (dashMatch) {
        // Authors are before the dash
        authors = dashMatch[1].trim();

        // Journal/source is after the dash
        const afterDash = dashMatch[2].trim();

        // Remove year pattern from end
        const yearMatch = afterDash.match(/^(.+?),?\s*(19|20)\d{2}$/);
        if (yearMatch) {
          journalName = yearMatch[1].replace(/,$/, '').trim();
        } else {
          journalName = afterDash.replace(/[,\s]+(19|20)\d{2}$/, '').trim();
        }

        // Validate journal name
        if (journalName.length <= 3 ||
            /^[\d\s\-.,;:]+$/.test(journalName) ||
            journalName.includes('...') ||
            journalName.includes('…')) {
          journalName = 'Google Scholar';
        }
      }
    }

    articles.push({
      title: title,
      authors: authors || undefined,
      abstract: snippet || undefined,
      journal: journalName,
      htmlContent: `<h3>${title}</h3>\n<div>${citation}</div>\n<div>${snippet}</div>`,
      estimatedTokens: estimateTokens(title + citation + snippet)
    });
  });

  return articles;
}

/**
 * Extract articles from bioRxiv/medRxiv emails
 * These can be HTML with links OR plain text with DOI patterns
 */
function extractBioRxivArticles(html: string): ExtractedArticle[] {
  const $ = cheerio.load(html);
  const articles: ExtractedArticle[] = [];

  // Strategy 1: HTML links (traditional format)
  $('a[href*="biorxiv.org"], a[href*="medrxiv.org"]').each((i, elem) => {
    const $link = $(elem);
    const href = $link.attr('href') || '';
    const title = $link.text().trim();

    if (title.length < 20 || title.toLowerCase().includes('unsubscribe')) return;

    const doiMatch = href.match(/10\.\d+\/[\d.]+/);
    const doi = doiMatch ? doiMatch[0] : undefined;

    const $context = $link.closest('tr, div');
    const contextHtml = $context.html() || $link.parent().html() || '';

    const journal = href.includes('medrxiv') ? 'medRxiv' : 'bioRxiv';

    articles.push({
      title: title,
      doi: doi,
      journal: journal,
      htmlContent: contextHtml,
      estimatedTokens: estimateTokens(contextHtml)
    });
  });

  // Strategy 2: Plain text format with DOI patterns (highwire alerts)
  // Pattern: Title\nAuthors\nbioRxiv posted DATE doi:DOI
  // Use raw html instead of $.text() to preserve text formatting
  if (articles.length === 0) {
    // Strip HTML tags but preserve newlines for plain text processing
    const plainText = html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .trim();

    // Split by DOI patterns to find article blocks
    // Support both doi: and doi.org URL formats
    const doiPattern = /doi[:\s]+\s*(10\.\d+\/[^\s\[\]<>]+)/gi;
    const doiMatches = [...plainText.matchAll(doiPattern)];

    if (doiMatches.length > 0) {
      logger.info(`[BioRxiv] Found ${doiMatches.length} DOIs in plain text format`);

      // For each DOI, extract the preceding title and authors
      for (const match of doiMatches) {
        const beforeDoi = plainText.substring(Math.max(0, match.index! - 600), match.index!);

        // Split into lines and find title (usually 2-3 lines before DOI)
        const lines = beforeDoi.split(/[\r\n]+/).filter(l => l.trim().length > 0);

        if (lines.length >= 1) {
          let titleLine = '';
          let authorsLine = '';

          // Work backwards from the DOI to find title and authors
          for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i].trim();

            // Skip "bioRxiv posted" / "medRxiv posted" line
            if (line.toLowerCase().includes('biorxiv posted') ||
                line.toLowerCase().includes('medrxiv posted') ||
                line.toLowerCase().includes('biorxiv ') ||
                line.toLowerCase().includes('medrxiv ')) {
              continue;
            }
            // Skip [Abstract] [PDF] links
            if (line.includes('[Abstract]') || line.includes('[PDF]') || line.includes('[Full Text]')) {
              continue;
            }
            // Skip section headers
            if (line === 'Bioinformatics' || line === 'Genomics' || line === 'Systems Biology' ||
                line.match(/^[A-Z][a-z]+(\s+[A-Z][a-z]+)*$/) && line.length < 30) {
              continue;
            }
            // If line contains " and " and commas, or looks like author list, it's likely authors
            if (!authorsLine && (
                (line.includes(' and ') && (line.match(/,/g) || []).length >= 1) ||
                (line.match(/,/g) || []).length >= 3 ||
                line.match(/^[A-Z][a-z]+ [A-Z][a-z]+,/)
            )) {
              authorsLine = line;
              continue;
            }
            // Otherwise it's the title (must be substantial)
            if (!titleLine && line.length > 25 && line.length < 400) {
              titleLine = line;
              break;
            }
          }

          if (titleLine) {
            const isMedRxiv = plainText.toLowerCase().includes('medrxiv');
            const journal = isMedRxiv ? 'medRxiv' : 'bioRxiv';

            logger.info(`[BioRxiv] Extracted: "${titleLine.substring(0, 50)}..." from ${journal}`);

            articles.push({
              title: titleLine,
              authors: authorsLine || undefined,
              doi: match[1],
              journal: journal,
              htmlContent: `${titleLine}\n${authorsLine || ''}\ndoi:${match[1]}`,
              estimatedTokens: estimateTokens(titleLine + (authorsLine || ''))
            });
          }
        }
      }
    } else {
      logger.warn(`[BioRxiv] No DOIs found in plain text (${plainText.length} chars)`);
    }
  }

  // Deduplicate by title
  const uniqueArticles: ExtractedArticle[] = [];
  const seenTitles = new Set<string>();

  for (const article of articles) {
    const normalizedTitle = article.title.toLowerCase().substring(0, 60);
    if (!seenTitles.has(normalizedTitle)) {
      seenTitles.add(normalizedTitle);
      uniqueArticles.push(article);
    }
  }

  logger.info(`[BioRxiv] Total extracted: ${uniqueArticles.length} articles`);
  return uniqueArticles;
}

/**
 * Extract articles from Nature emails
 * Nature uses specific span/link styling for article titles, abstracts, and authors
 * ONLY extracts from the "Research" section (News & Views, Reviews, Articles)
 *
 * @param html - Email HTML content
 * @param journalName - Specific journal name (e.g., "Nature Medicine", "Nature Aging")
 */
function extractNatureArticles(html: string, journalName: string = 'Nature'): ExtractedArticle[] {
  const $ = cheerio.load(html);
  const articles: ExtractedArticle[] = [];

  // Step 1: Find and extract only the research sections HTML
  // Nature research content is in: "News & Views", "Reviews", and "Articles" sections
  let researchSectionHtml = ''; // Will accumulate research sections

  const htmlLower = html.toLowerCase();

  // Find the three research subsections: News & Views, Reviews, Articles
  const researchSectionNames = ['news &amp; views', 'news & views', 'reviews', 'articles'];

  for (const sectionName of researchSectionNames) {
    const pattern = new RegExp(`<h[23][^>]*>\\s*${sectionName}[^<]*<\\/h[23]>`, 'i');
    const match = htmlLower.match(pattern);

    if (match && match.index !== undefined) {
      const startIdx = match.index;

      // Find next h2/h3 heading (end of this subsection)
      const afterSection = htmlLower.substring(startIdx + match[0].length);
      const endMatch = afterSection.match(/<h[23][^>]*>/);

      if (endMatch && endMatch.index !== undefined) {
        const endIdx = startIdx + match[0].length + endMatch.index;
        const sectionHtml = html.substring(startIdx, endIdx);
        researchSectionHtml += sectionHtml;
        logger.info(`[ArticleExtractor] Found "${sectionName}" section (${(sectionHtml.length / 1024).toFixed(1)} KB)`);
      } else {
        // No end found, take rest of email
        const sectionHtml = html.substring(startIdx);
        researchSectionHtml += sectionHtml;
        logger.info(`[ArticleExtractor] Found "${sectionName}" section to end (${(sectionHtml.length / 1024).toFixed(1)} KB)`);
      }
    }
  }

  if (researchSectionHtml.length === 0) {
    logger.warn(`[ArticleExtractor] Could not find research sections in Nature email, using full email`);
    researchSectionHtml = html;
  } else {
    logger.info(`[ArticleExtractor] Total research content: ${(researchSectionHtml.length / 1024).toFixed(1)} KB`);
  }

  // Step 2: Parse only the research section HTML
  const $research = cheerio.load(researchSectionHtml);

  // Extract articles from research section
  // Pattern: <span style="font-size: 18px;"><a href="...">Title</a>
  $research('span').each((i, elem) => {
    const $span = $research(elem);
    const style = $span.attr('style') || '';

    // Check if this is an article title container (font-size: 18px)
    if (!style.includes('font-size: 18px') && !style.includes('font-size:18px')) {
      return;
    }

    const $link = $span.find('a');
    if ($link.length === 0) return;

    const href = $link.attr('href') || '';
    const title = $link.text().trim();

    // Filter: must be substantial title, must be Nature link
    if (title.length < 20 || title.length > 500) return;
    if (!href.includes('springernature.com') && !href.includes('nature.com')) return;

    // Get surrounding context for abstract and authors
    const $parent = $span.closest('td');
    const contextHtml = $parent.html() || '';

    // Try to extract abstract (next sibling span with font-size: 16px)
    let abstract = '';
    $parent.find('span').each((j, sibElem) => {
      const sibStyle = $research(sibElem).attr('style') || '';
      if (sibStyle.includes('font-size: 16px') || sibStyle.includes('font-size:16px')) {
        const text = $research(sibElem).text().trim();
        if (text.length > 50 && text.length < 1000) {
          abstract = text;
        }
      }
    });

    // Try to extract authors (span with font-size: 14px and font-weight: bold)
    let authors = '';
    $parent.find('span').each((j, sibElem) => {
      const sibStyle = $research(sibElem).attr('style') || '';
      if ((sibStyle.includes('font-size: 14px') || sibStyle.includes('font-size:14px')) &&
          (sibStyle.includes('font-weight: bold') || sibStyle.includes('font-weight:bold'))) {
        authors = $research(sibElem).text().trim();
      }
    });

    articles.push({
      title: title,
      authors: authors || undefined,
      abstract: abstract || undefined,
      journal: journalName,
      htmlContent: contextHtml,
      estimatedTokens: estimateTokens(contextHtml)
    });
  });

  // Strategy 2: Find table cells with article-like content (fallback)
  if (articles.length === 0) {
    $('td').each((i, elem) => {
      const $td = $(elem);
      const text = $td.text().trim();

      // Look for table cells with substantial content that looks like an article
      if (text.length < 100 || text.length > 2000) return;

      // Check for Nature article patterns
      const $link = $td.find('a[href*="springernature"], a[href*="nature.com"]');
      if ($link.length === 0) return;

      const linkText = $link.first().text().trim();
      if (linkText.length < 20) return;

      // Skip navigation and footer content
      if (text.includes('unsubscribe') || text.includes('©') ||
          text.includes('preferences') || text.includes('Sign up')) return;

      articles.push({
        title: linkText,
        journal: journalName,
        htmlContent: $td.html() || '',
        estimatedTokens: estimateTokens($td.html() || '')
      });
    });
  }

  // Deduplicate by title
  const uniqueArticles: ExtractedArticle[] = [];
  const seenTitles = new Set<string>();

  for (const article of articles) {
    const normalizedTitle = article.title.substring(0, 80).toLowerCase().trim();
    if (!seenTitles.has(normalizedTitle)) {
      seenTitles.add(normalizedTitle);
      uniqueArticles.push(article);
    }
  }

  return uniqueArticles;
}

/**
 * Extract articles from AHA Journals emails
 * Uses bold links with specific styling (can be on <a> or <span> inside <a>)
 * Also extracts specific journal names (Circulation, Hypertension, Stroke, etc.)
 */
function extractAHAArticles(html: string, emailSubject: string = ''): ExtractedArticle[] {
  const $ = cheerio.load(html);
  const articles: ExtractedArticle[] = [];

  // Try to extract specific AHA journal name from subject or content
  const detectAHAJournal = (context: string): string => {
    const text = (emailSubject + ' ' + context).toLowerCase();
    if (text.includes('circulation research')) return 'Circulation Research';
    if (text.includes('circulation: heart failure') || text.includes('circ heart fail')) return 'Circulation: Heart Failure';
    if (text.includes('circulation: genomic') || text.includes('circ genom')) return 'Circulation: Genomic and Precision Medicine';
    if (text.includes('circulation')) return 'Circulation';
    if (text.includes('hypertension')) return 'Hypertension';
    if (text.includes('stroke')) return 'Stroke';
    if (text.includes('arteriosclerosis')) return 'Arteriosclerosis, Thrombosis, and Vascular Biology';
    if (text.includes('atvb')) return 'Arteriosclerosis, Thrombosis, and Vascular Biology';
    if (text.includes('jaha') || text.includes('journal of the american heart')) return 'JAHA';
    if (text.includes('circ cardiovasc')) return 'Circulation: Cardiovascular';
    return 'AHA Journals';
  };

  // Strategy 1: Direct styling on <a> tag
  $('a[style*="font-weight:bold"], a[style*="font-weight: bold"], a[style*="font-size:18px"], a[style*="font-size: 18px"]').each((i, elem) => {
    const $link = $(elem);
    let title = $link.text().trim();
    title = title.replace(/\s+/g, ' '); // Normalize whitespace

    if (title.length < 15) return;
    // Skip navigation links
    if (title.toLowerCase().includes('view in browser') ||
        title.toLowerCase().includes('unsubscribe') ||
        title.toLowerCase().includes('privacy policy')) return;

    const href = $link.attr('href') || '';

    // Extract DOI if present
    const doiMatch = href.match(/doi\/(?:full\/|abs\/)?([0-9.]+\/[^\s?&]+)/i);
    const doi = doiMatch ? doiMatch[1] : undefined;

    // Get surrounding context (authors, citation info)
    const $context = $link.closest('td, div, tr');
    const contextHtml = $context.html() || '';

    const journal = detectAHAJournal(contextHtml);

    articles.push({
      title: title,
      doi: doi,
      journal: journal,
      htmlContent: contextHtml,
      estimatedTokens: estimateTokens(contextHtml)
    });
  });

  // Strategy 2: Styling on <span> inside <a> (newer AHA format)
  // Pattern: <a><span class="issue-item__title" style="font-size:18px; font-weight: bold">TITLE</span></a>
  $('span[style*="font-weight"], span[class*="title"]').each((i, elem) => {
    const $span = $(elem);
    const style = $span.attr('style') || '';
    const className = $span.attr('class') || '';

    // Must have bold styling or title class
    const hasBoldStyle = style.includes('font-weight') || className.includes('title');
    if (!hasBoldStyle) return;

    const title = $span.text().trim().replace(/\s+/g, ' ');
    if (title.length < 15) return;

    // Skip navigation
    if (title.toLowerCase().includes('view in browser') ||
        title.toLowerCase().includes('unsubscribe')) return;

    // Check if this span is inside an <a> tag or near one
    const $link = $span.closest('a');
    let href = '';
    if ($link.length > 0) {
      href = $link.attr('href') || '';
    } else {
      // Try to find a nearby link
      const $parent = $span.parent();
      const $nearbyLink = $parent.find('a').first();
      if ($nearbyLink.length > 0) {
        href = $nearbyLink.attr('href') || '';
      }
    }

    // Extract DOI if present
    const doiMatch = href.match(/doi\/(?:full\/|abs\/)?([0-9.]+\/[^\s?&]+)/i);
    const doi = doiMatch ? doiMatch[1] : undefined;

    // Get surrounding context (authors, citation info)
    const $context = $span.closest('td, div, table, tr');
    const contextHtml = $context.html() || '';

    // Try to find authors - AHA uses nested tables, so search up multiple levels
    let authors = '';
    // First try immediate context
    let $authorsElem = $context.find('.loa, [class*="author"], [class*="contrib"]').first();
    // If not found, try parent table
    if ($authorsElem.length === 0) {
      const $parentTable = $context.closest('table').parent().closest('table');
      $authorsElem = $parentTable.find('.loa, [class*="author"], [class*="contrib"]').first();
    }
    // If still not found, try grandparent table
    if ($authorsElem.length === 0) {
      const $grandTable = $context.closest('table').parent().closest('table').parent().closest('table');
      $authorsElem = $grandTable.find('.loa, [class*="author"], [class*="contrib"]').first();
    }
    if ($authorsElem.length > 0) {
      authors = $authorsElem.text().trim();
      // Clean up author string - remove extra whitespace
      authors = authors.replace(/\s+/g, ' ');
    }

    const journal = detectAHAJournal(contextHtml);

    articles.push({
      title: title,
      authors: authors || undefined,
      doi: doi,
      journal: journal,
      htmlContent: contextHtml,
      estimatedTokens: estimateTokens(contextHtml)
    });
  });

  // Strategy 3: Look for article patterns by structure (table-based layouts)
  if (articles.length === 0) {
    logger.info(`[AHA] Strategies 1-2 found nothing, trying table-based extraction`);

    $('td').each((i, elem) => {
      const $td = $(elem);
      const text = $td.text().trim();

      // Look for cells with substantial content that could be article titles
      if (text.length < 30 || text.length > 500) return;

      // Check for AHA article link patterns
      const $link = $td.find('a[href*="ahajournals.org"], a[href*="doi.org"]');
      if ($link.length === 0) return;

      const title = $link.first().text().trim();
      if (title.length < 15) return;

      const href = $link.first().attr('href') || '';
      const doiMatch = href.match(/doi\/(?:full\/|abs\/)?([0-9.]+\/[^\s?&]+)/i);
      const doi = doiMatch ? doiMatch[1] : undefined;

      const contextHtml = $td.html() || '';
      const journal = detectAHAJournal(contextHtml);

      articles.push({
        title: title,
        doi: doi,
        journal: journal,
        htmlContent: contextHtml,
        estimatedTokens: estimateTokens(contextHtml)
      });
    });
  }

  // Deduplicate by title
  const uniqueArticles: ExtractedArticle[] = [];
  const seenTitles = new Set<string>();

  for (const article of articles) {
    const normalizedTitle = article.title.toLowerCase().substring(0, 50);
    if (!seenTitles.has(normalizedTitle)) {
      seenTitles.add(normalizedTitle);
      uniqueArticles.push(article);
    }
  }

  logger.info(`[AHA] Total extracted: ${uniqueArticles.length} articles`);
  return uniqueArticles;
}

/**
 * Main extraction function - detects email type and extracts articles
 */
export function extractArticlesFromEmail(
  emailHtml: string,
  emailFrom: string,
  emailSubject: string
): ExtractedArticle[] {
  const fromLower = emailFrom.toLowerCase();

  logger.info(`[ArticleExtractor] Extracting from: ${emailFrom.substring(0, 50)}`);

  let articles: ExtractedArticle[] = [];

  // Detect email source and use appropriate extraction strategy
  if (fromLower.includes('scholar') || fromLower.includes('google')) {
    articles = extractGoogleScholarArticles(emailHtml);
  } else if (fromLower.includes('cellpress') || fromLower.includes('cell.com') || fromLower.includes('elsevier')) {
    articles = extractCellPressArticles(emailHtml, emailSubject);
  } else if (fromLower.includes('nature') || fromLower.includes('alerts@nature')) {
    // Extract journal name from subject for Nature Portfolio emails
    // Subject examples: "Nature Medicine", "Nature Aging", "Nature Communications"
    let journalName = 'Nature';
    const subjectLower = emailSubject.toLowerCase();

    // Try to extract specific Nature journal name from subject
    const natureJournals = [
      'Nature Medicine', 'Nature Aging', 'Nature Communications',
      'Nature Genetics', 'Nature Methods', 'Nature Neuroscience',
      'Nature Cell Biology', 'Nature Immunology', 'Nature Biotechnology',
      'Nature Chemical Biology', 'Nature Structural & Molecular Biology',
      'Nature Reviews', 'Nature Climate Change', 'Nature Energy',
      'Nature Materials', 'Nature Nanotechnology', 'Nature Physics',
      'Nature Photonics', 'Nature Plants', 'Nature Protocols',
      'Communications Biology'
    ];

    for (const journal of natureJournals) {
      if (subjectLower.includes(journal.toLowerCase())) {
        journalName = journal;
        break;
      }
    }

    // Fallback: try to extract from subject pattern
    if (journalName === 'Nature' && emailSubject) {
      // Match patterns like "Nature Xxx" at start of subject
      const match = emailSubject.match(/^(Nature\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
      if (match) {
        journalName = match[1];
      }
    }

    logger.info(`[ArticleExtractor] Nature journal detected: ${journalName}`);
    articles = extractNatureArticles(emailHtml, journalName);
  } else if (fromLower.includes('biorxiv') || fromLower.includes('medrxiv') || fromLower.includes('highwire')) {
    articles = extractBioRxivArticles(emailHtml);
  } else if (fromLower.includes('ahajournals') || fromLower.includes('heart.org')) {
    articles = extractAHAArticles(emailHtml, emailSubject);
  } else {
    // Generic fallback: try all strategies
    logger.warn(`[ArticleExtractor] Unknown email source, using generic extraction`);
    articles = [
      ...extractGoogleScholarArticles(emailHtml),
      ...extractNatureArticles(emailHtml),
      ...extractCellPressArticles(emailHtml, emailSubject),
      ...extractBioRxivArticles(emailHtml),
      ...extractAHAArticles(emailHtml, emailSubject)
    ];
  }

  logger.success(`[ArticleExtractor] Extracted ${articles.length} articles from ${emailFrom.substring(0, 30)}`);

  // If extraction found nothing, return the whole email as one article
  if (articles.length === 0) {
    logger.warn(`[ArticleExtractor] No articles found, using entire email`);
    articles = [{
      title: emailSubject,
      journal: 'Unknown',
      htmlContent: emailHtml,
      estimatedTokens: estimateTokens(emailHtml)
    }];
  }

  return articles;
}

/**
 * Batch articles into groups based on token limits
 */
export function batchArticlesByTokens(
  articles: ExtractedArticle[],
  maxTokensPerBatch: number = 15000,
  maxArticlesPerBatch: number = 30
): ExtractedArticle[][] {
  const batches: ExtractedArticle[][] = [];
  let currentBatch: ExtractedArticle[] = [];
  let currentTokens = 0;

  for (const article of articles) {
    // Check if adding this article would exceed limits
    if ((currentTokens + article.estimatedTokens > maxTokensPerBatch ||
         currentBatch.length >= maxArticlesPerBatch) &&
        currentBatch.length > 0) {
      batches.push(currentBatch);
      currentBatch = [];
      currentTokens = 0;
    }

    currentBatch.push(article);
    currentTokens += article.estimatedTokens;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}
