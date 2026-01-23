/**
 * Analyze Nature Email Structure
 */
import fs from 'fs';
import * as cheerio from 'cheerio';

const data = JSON.parse(fs.readFileSync('./debug/test.json', 'utf-8'));
const natureEmail = data[1]; // Second email is Nature

console.log('='.repeat(80));
console.log('NATURE EMAIL ANALYSIS');
console.log('='.repeat(80));
console.log(`From: ${natureEmail.from}`);
console.log(`Subject: ${natureEmail.subject}`);
console.log(`Date: ${natureEmail.date}`);
console.log(`Body size: ${(natureEmail.body.length / 1024).toFixed(1)} KB\n`);

// Load HTML with cheerio
const $ = cheerio.load(natureEmail.body);

// 1. Find all section headers (h2, h3)
console.log('\n📑 SECTION STRUCTURE:');
console.log('─'.repeat(80));

const sections = [];
$('h2, h3').each((i, elem) => {
  const $elem = $(elem);
  const text = $elem.text().trim().replace(/\s+/g, ' ');
  const tag = elem.name;
  if (text.length > 0 && text.length < 100) {
    sections.push({ tag, text });
    console.log(`${tag.toUpperCase()}: ${text}`);
  }
});

console.log(`\nTotal sections found: ${sections.length}`);

// 2. Find all article-like links
console.log('\n\n🔗 ARTICLE LINKS ANALYSIS:');
console.log('─'.repeat(80));

const articleLinks = [];
$('a').each((i, elem) => {
  const $link = $(elem);
  const href = $link.attr('href') || '';
  const text = $link.text().trim().replace(/\s+/g, ' ');

  // Filter for Nature article links
  if ((href.includes('springernature.com') || href.includes('nature.com')) &&
      text.length > 20 &&
      !text.toLowerCase().includes('unsubscribe') &&
      !text.toLowerCase().includes('preference')) {
    articleLinks.push({ text, href: href.substring(0, 80) });
  }
});

console.log(`Found ${articleLinks.length} potential article links\n`);
for (let i = 0; i < Math.min(10, articleLinks.length); i++) {
  console.log(`${i + 1}. ${articleLinks[i].text.substring(0, 70)}...`);
}

// 3. Analyze span structure (Nature uses specific font-size styling)
console.log('\n\n📐 SPAN STYLING ANALYSIS:');
console.log('─'.repeat(80));

const spanStyles = new Map();
$('span').each((i, elem) => {
  const $span = $(elem);
  const style = $span.attr('style') || '';

  // Extract font-size
  const fontSizeMatch = style.match(/font-size:\s*(\d+)px/);
  if (fontSizeMatch) {
    const fontSize = fontSizeMatch[1];
    const text = $span.text().trim().substring(0, 100);

    if (!spanStyles.has(fontSize)) {
      spanStyles.set(fontSize, []);
    }
    if (text.length > 20) {
      spanStyles.get(fontSize).push(text);
    }
  }
});

console.log('Font sizes used and sample content:');
for (const [fontSize, samples] of Array.from(spanStyles.entries()).sort((a, b) => parseInt(b[0]) - parseInt(a[0]))) {
  console.log(`\n${fontSize}px (${samples.length} instances):`);
  for (let i = 0; i < Math.min(3, samples.length); i++) {
    console.log(`  - ${samples[i].substring(0, 80)}...`);
  }
}

// 4. Look for table-based structure
console.log('\n\n📊 TABLE STRUCTURE:');
console.log('─'.repeat(80));

const tables = $('table');
console.log(`Total tables: ${tables.length}`);

// Analyze table cells with substantial content
let articleCells = 0;
$('td').each((i, elem) => {
  const $td = $(elem);
  const text = $td.text().trim();

  // Check if cell contains article-like content
  if (text.length > 100 && text.length < 2000) {
    const hasLink = $td.find('a[href*="nature"]').length > 0;
    if (hasLink) {
      articleCells++;
    }
  }
});

console.log(`Table cells with article-like content: ${articleCells}`);

// 5. Extract actual article structure (18px spans with links)
console.log('\n\n📄 EXTRACTED ARTICLES (using 18px span + link pattern):');
console.log('─'.repeat(80));

const extractedArticles = [];
$('span').each((i, elem) => {
  const $span = $(elem);
  const style = $span.attr('style') || '';

  if (style.includes('font-size: 18px') || style.includes('font-size:18px')) {
    const $link = $span.find('a');
    if ($link.length > 0) {
      const title = $link.text().trim();
      const href = $link.attr('href') || '';

      if (title.length > 20 && (href.includes('springernature') || href.includes('nature.com'))) {
        const $parent = $span.closest('td');

        // Look for abstract (16px span)
        let abstract = '';
        $parent.find('span').each((j, sibElem) => {
          const sibStyle = $(sibElem).attr('style') || '';
          if (sibStyle.includes('font-size: 16px')) {
            const text = $(sibElem).text().trim();
            if (text.length > 50 && text.length < 1000) {
              abstract = text;
            }
          }
        });

        // Look for authors (14px bold span)
        let authors = '';
        $parent.find('span').each((j, sibElem) => {
          const sibStyle = $(sibElem).attr('style') || '';
          if (sibStyle.includes('font-size: 14px') && sibStyle.includes('font-weight: bold')) {
            authors = $(sibElem).text().trim();
          }
        });

        extractedArticles.push({ title, abstract: abstract.substring(0, 150), authors: authors.substring(0, 80) });
      }
    }
  }
});

console.log(`Extracted ${extractedArticles.length} articles:\n`);
for (let i = 0; i < extractedArticles.length; i++) {
  const article = extractedArticles[i];
  console.log(`${i + 1}. ${article.title}`);
  if (article.authors) {
    console.log(`   Authors: ${article.authors}${article.authors.length >= 80 ? '...' : ''}`);
  }
  if (article.abstract) {
    console.log(`   Abstract: ${article.abstract}...`);
  }
  console.log();
}

// Summary
console.log('\n' + '='.repeat(80));
console.log('SUMMARY');
console.log('='.repeat(80));
console.log(`Email sections: ${sections.length}`);
console.log(`Article links found: ${articleLinks.length}`);
console.log(`Articles extracted (18px pattern): ${extractedArticles.length}`);
console.log(`Font sizes used: ${Array.from(spanStyles.keys()).join(', ')}px`);
console.log('='.repeat(80));
