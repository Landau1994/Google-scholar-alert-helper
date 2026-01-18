import './loadEnv.ts';
import fs from 'fs';
import path from 'path';
import { generateLiteratureReview } from '../services/geminiService.ts';
import type { Paper } from '../types.ts';
import { setGlobalDispatcher, ProxyAgent } from 'undici';

// Configure proxy for Node.js fetch
const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY || 'http://localhost:7897';
if (proxyUrl) {
  const dispatcher = new ProxyAgent(proxyUrl);
  setGlobalDispatcher(dispatcher);
  console.log(`Global dispatcher set to ProxyAgent (${proxyUrl})`);
}

if (!process.env.VITE_GEMINI_API_KEY) {
    console.error("No API Key found in .env.local");
    process.exit(1);
}

// Parse command line arguments
const args = process.argv.slice(2);
let minScore = 20; // Default minScore

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--minScore' && args[i + 1]) {
        minScore = parseInt(args[i + 1], 10);
        i++;
    }
}

// Also try to load from scheduler.config.json
const configPath = path.resolve(process.cwd(), 'scheduler.config.json');
try {
    if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (config.minScore !== undefined && !args.includes('--minScore')) {
            minScore = config.minScore;
        }
    }
} catch (e) {
    // Ignore config loading errors
}

console.log(`Using minScore: ${minScore}`);

const syncedEmailsDir = path.resolve(process.cwd(), 'synced_emails');

async function main() {
    console.log("Reading analysis files...");
    if (!fs.existsSync(syncedEmailsDir)) {
      console.error("synced_emails directory not found");
      process.exit(1);
    }

    const allFiles = fs.readdirSync(syncedEmailsDir).filter(f => f.startsWith('analysis-') && f.endsWith('.json'));
    
    if (allFiles.length === 0) {
        console.log("No analysis files found.");
        process.exit(0);
    }

    // Parse timestamps and find the latest run
    const fileInfos = allFiles.map(f => {
        const match = f.match(/analysis-(\d+)\.json/);
        return {
            filename: f,
            timestamp: match ? parseInt(match[1], 10) : 0
        };
    });

    // Sort by timestamp descending (newest first)
    fileInfos.sort((a, b) => b.timestamp - a.timestamp);

    const latestTimestamp = fileInfos[0].timestamp;
    // Define a "run" as files created within 10 minutes of the latest file
    const TIME_WINDOW_MS = 10 * 60 * 1000; 
    
    const relevantFiles = fileInfos.filter(f => (latestTimestamp - f.timestamp) <= TIME_WINDOW_MS);
    
    console.log(`Latest run detected at: ${new Date(latestTimestamp).toLocaleString()}`);
    console.log(`Processing ${relevantFiles.length} files from the latest run (window: 10 mins).`);
    console.log(`Ignored ${allFiles.length - relevantFiles.length} older files.`);

    let allPapers: Paper[] = [];
    
    for (const info of relevantFiles) {
        const file = info.filename;
        try {
            const content = JSON.parse(fs.readFileSync(path.join(syncedEmailsDir, file), 'utf-8'));
            if (content.papers && Array.isArray(content.papers)) {
                allPapers.push(...content.papers);
            }
        } catch (e) {
            console.warn(`Failed to read or parse ${file}:`, e);
        }
    }
    
    console.log(`Found ${allPapers.length} total papers.`);
    
    // Deduplicate
    const uniquePapers = new Map<string, Paper>();
    for (const p of allPapers) {
        // Normalize title
        const key = p.title.toLowerCase().trim();
        if (!uniquePapers.has(key)) {
            uniquePapers.set(key, p);
        } else {
            // Keep the one with higher relevance score? or more info?
            const existing = uniquePapers.get(key)!;
            if ((p.relevanceScore || 0) > (existing.relevanceScore || 0)) {
                uniquePapers.set(key, p);
            }
        }
    }
    
    const papers = Array.from(uniquePapers.values());
    console.log(`Unique papers: ${papers.length}`);

    // Filter by minScore
    const filteredPapers = papers.filter(p => (p.relevanceScore || 0) >= minScore);
    console.log(`Papers above minScore (${minScore}): ${filteredPapers.length}`);

    // Sort by relevance
    filteredPapers.sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0));

    // Generate Markdown List
    let mdContent = "# Consolidated Paper List\n\n";
    mdContent += `Generated on ${new Date().toLocaleString()}\n`;
    mdContent += `Total Papers: ${filteredPapers.length} (filtered from ${papers.length} unique, minScore=${minScore})\n\n`;

    for (const [i, p] of filteredPapers.entries()) {
        mdContent += `## ${i+1}. ${p.title}\n`;
        mdContent += `**Authors:** ${p.authors ? p.authors.join(', ') : 'Unknown'}\n`;
        mdContent += `**Source:** ${p.source} (${p.date})\n`;
        mdContent += `**Score:** ${p.relevanceScore}\n`;
        if (p.snippet) mdContent += `**Snippet:** ${p.snippet}\n`;
        mdContent += `\n---\n\n`;
    }
    
    fs.writeFileSync('consolidated_papers.md', mdContent);
    console.log("✅ SUCCESS: Created 'consolidated_papers.md' with verified unique papers.");
    console.log("------------------------------------------------------------");

    // Aggregate keywords from filtered papers
    const keywordCounts = new Map<string, number>();
    for (const p of filteredPapers) {
        if (p.matchedKeywords) {
            for (const k of p.matchedKeywords) {
                const normalized = k.toLowerCase().trim();
                if (normalized) {
                    keywordCounts.set(normalized, (keywordCounts.get(normalized) || 0) + 1);
                }
            }
        }
    }

    const topKeywords = Array.from(keywordCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(e => e[0]);

    console.log("Top keywords:", topKeywords);

    if (filteredPapers.length > 0) {
        console.log("🚀 Starting Literature Review generation (Plan & Parallel)...");
        console.log("Using 'gemini-3-flash-preview' for planning and 'gemini-3-pro-preview' for writing.");
        try {
            // Pass filtered papers (already filtered by minScore)
            const review = await generateLiteratureReview(filteredPapers, topKeywords);
            fs.writeFileSync('literature_review.md', review);
            console.log("✅ SUCCESS: Created 'literature_review.md'.");
        } catch (e) {
            console.error("❌ Failed to generate review:", e);
            console.log("⚠️  Note: Your extracted papers are safe in 'consolidated_papers.md'.");
        }
    } else {
        console.log("No papers to process.");
    }
}

main().catch(console.error);
