import * as cheerio from 'cheerio';
import fs from 'fs';

const testData = JSON.parse(fs.readFileSync('./debug/test_quick.json', 'utf-8'));
const scholarEmail = testData.find((e: any) => e.from?.toLowerCase().includes('scholar'));

const $ = cheerio.load(scholarEmail.body);

const $h3 = $('h3').eq(2);
let $next = $h3.next();
const citation = $next.text().trim();

console.log('Citation:', citation);
console.log('Length:', citation.length);

// Check each character around the dash
for (let i = 0; i < citation.length; i++) {
  const char = citation[i];
  const code = char.charCodeAt(0);
  if (code > 127 || char === '-' || char === '–' || char === '—') {
    console.log(`Char ${i}: "${char}" (code: ${code})`);
  }
}

// Try different dash patterns
console.log('\nSearch results:');
console.log('indexOf(" - "):', citation.indexOf(' - '));
console.log('indexOf(" – "):', citation.indexOf(' – ')); // en-dash
console.log('indexOf(" — "):', citation.indexOf(' — ')); // em-dash
console.log('indexOf("- "):', citation.indexOf('- '));
console.log('indexOf(" -"):', citation.indexOf(' -'));

// Use regex to find dash-like characters
const dashMatch = citation.match(/\s[-–—]\s/);
console.log('Regex match:', dashMatch);
