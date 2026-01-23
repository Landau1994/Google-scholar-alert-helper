import * as cheerio from 'cheerio';
import fs from 'fs';

const testData = JSON.parse(fs.readFileSync('./debug/test_quick.json', 'utf-8'));

const ahaEmail = testData.find((e: any) => e.from?.includes('heart.org'));
if (ahaEmail) {
  const $ = cheerio.load(ahaEmail.body);

  let found = 0;
  // Find title spans
  $('span').each((i, elem) => {
    const style = $(elem).attr('style') || '';
    const text = $(elem).text().trim();

    if (style.includes('font-size:18px') && style.includes('font-weight') &&
        text.length > 30 && found < 1) {

      found++;
      console.log('=== AHA Article Structure ===');
      console.log('Title:', text.substring(0, 60));

      // Get parent tables at different levels
      const $td = $(elem).closest('td');
      const $tr = $(elem).closest('tr');
      const $table1 = $(elem).closest('table');
      const $table2 = $table1.parent().closest('table');

      console.log('\n--- Parent TD content ---');
      console.log($td.text().trim().replace(/\s+/g, ' ').substring(0, 200));

      console.log('\n--- Sibling TDs ---');
      $td.siblings('td').each((j, sib) => {
        const sibText = $(sib).text().trim().replace(/\s+/g, ' ');
        if (sibText.length > 5 && sibText.length < 200) {
          console.log(`Sibling ${j}: ${sibText.substring(0, 100)}`);
        }
      });

      console.log('\n--- Next rows in table ---');
      let $nextRow = $tr.next('tr');
      for (let k = 0; k < 3 && $nextRow.length; k++) {
        const rowText = $nextRow.text().trim().replace(/\s+/g, ' ');
        if (rowText.length > 5 && rowText.length < 300) {
          console.log(`Next row ${k}: ${rowText.substring(0, 120)}`);
        }
        $nextRow = $nextRow.next('tr');
      }

      console.log('\n--- Looking for author/loa classes ---');
      $table2.find('[class]').each((j, el) => {
        const cls = $(el).attr('class') || '';
        if (cls.includes('author') || cls.includes('loa') || cls.includes('contrib')) {
          console.log(`Found class "${cls}": ${$(el).text().trim().substring(0, 60)}`);
        }
      });
    }
  });

  if (found === 0) {
    console.log('No AHA title spans found. Checking all bold text...');
    $('span[style*="font-weight"]').slice(0, 5).each((i, elem) => {
      const text = $(elem).text().trim();
      if (text.length > 20) {
        console.log(`Bold span ${i}: ${text.substring(0, 60)}...`);
      }
    });
  }
}
